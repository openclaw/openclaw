import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";

const readLines = (file: string) => readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
const sortedPids = (pids: number[]) => pids.toSorted((a, b) => a - b);
type Observation = { kind: string; pid: number; databasePath: string };

export function createPrivateHandoffStoreFixture(
  directory: string,
  inheritedPath = process.env.PATH ?? "",
) {
  const root = join(realpathSync(directory), ".local", "private-handoff");
  const storeRoot = join(root, "store");
  mkdirSync(storeRoot, { recursive: true, mode: 0o700 });
  assert.equal(realpathSync(storeRoot), storeRoot);
  const databasePath = join(storeRoot, "managed-update-handoffs.sqlite");
  const observations = join(root, "observations.jsonl");
  const preload = join(root, "preload.mjs");
  const launches = join(root, "launches.txt");
  const bin = join(root, "bin");
  const preloadOption = `--import=${pathToFileURL(preload).href}`;
  const shellQuote = (value: string) => `'${value.replace(/'/gu, `'\\''`)}'`;
  mkdirSync(bin, { recursive: true });
  writeFileSync(launches, "");
  // Record independently of NODE_OPTIONS, and refuse access without injection.
  writeFileSync(
    join(bin, "node"),
    `#!/bin/sh
set -eu
for arg in "$@"; do
  case "$arg" in
    */scripts/pr-lib/worktree-provision.mts)
      printf "%s\\n" "$$" >> ${shellQuote(launches)}
      case " \${NODE_OPTIONS-} " in *${shellQuote(` ${preloadOption} `)}*) ;;
        *) echo 'Missing private handoff preload' >&2; exit 97 ;;
      esac
      break ;;
  esac
done
exec ${shellQuote(realpathSync(resolveTestNodeExecPath()))} "$@"
`,
  );
  chmodSync(join(bin, "node"), 0o755);
  writeFileSync(observations, "");
  writeFileSync(
    preload,
    `
import assert from "node:assert/strict";
import { appendFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Verify injection even when native Git needs no config write.
const entry = process.argv[1];
if (entry?.endsWith("/scripts/pr-lib/worktree-provision.mts")) {
  const sourceRoot = path.resolve(path.dirname(realpathSync(entry)), "../..");
  const [storeRoot, databasePath, observations] = ${JSON.stringify([storeRoot, databasePath, observations])};
  assert.equal(realpathSync(storeRoot), storeRoot);
  const require = createRequire(path.join(sourceRoot, "package.json"));
  const load = (file) => import(pathToFileURL(path.join(sourceRoot, file)).href);
  const { resolveSecureTempRoot } = require("@openclaw/fs-safe/temp");
  const { registerSealedRuntime } = await load("src/infra/sealed-runtime-registry.ts");
  let phase = "preflight";
  const observe = (kind) => appendFileSync(observations, JSON.stringify({
    kind, pid: process.pid, sourceRoot, databasePath,
  }) + "\\n");
  registerSealedRuntime({
    json5: require("json5"),
    resolveSecureTempRoot(options) {
      const resolved = resolveSecureTempRoot({ ...options, preferredDir: storeRoot });
      assert.equal(resolved, storeRoot);
      assert.equal(realpathSync(resolved), storeRoot);
      observe(phase + "-resolved");
      return resolved;
    },
  });
  await load("scripts/tsx.mjs");
  const { createManagedHandoffLeaseStore, resolveManagedUpdateLeaseDatabasePath } = await load(
    "src/infra/update-managed-service-handoff-lease.ts"
  );
  assert.equal(resolveManagedUpdateLeaseDatabasePath(), databasePath);
  observe("injected");
  // Preflight proves isolation, not later workload access; never select a live fallback.
  const store = createManagedHandoffLeaseStore({
    databasePath: resolveManagedUpdateLeaseDatabasePath(),
    serviceManagerEnv: process.env,
  });
  store.assertSourceUnborrowed(path.join(storeRoot, "provisioner-preflight-config.json"));
  observe("preflight-store-verified");
  phase = "runtime";
}
`,
  );
  return {
    env: {
      PATH: [bin, inheritedPath].join(delimiter),
      NODE_OPTIONS: preloadOption,
    },
    assertProvisionersInjected() {
      const rows = readLines(observations).map((line) => JSON.parse(line) as Observation);
      const injected = rows.filter((row) => row.kind === "injected");
      const launched = readLines(launches).map(Number);
      assert.ok(launched.length > 0, "cold provisioner never launched through the private owner");
      assert.ok(launched.every((pid) => Number.isSafeInteger(pid) && pid > 0));
      assert.equal(new Set(launched).size, launched.length, "ambiguous reused provisioner PID");
      assert.deepEqual(
        sortedPids(injected.map((row) => row.pid)),
        sortedPids(launched),
        "not every launched provisioner received its private store",
      );
      assert.ok(rows.every((row) => row.databasePath === databasePath));
      for (const { pid } of injected) {
        const kinds = new Set(rows.filter((row) => row.pid === pid).map((row) => row.kind));
        assert.ok(kinds.has("preflight-store-verified") && kinds.has("preflight-resolved"));
      }
      assert.equal(realpathSync(storeRoot), storeRoot);
    },
  };
}
