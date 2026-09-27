import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Bind each cold provisioner process through the existing sealed-runtime DI seam. */
export function createPrivateHandoffStoreFixture(
  directory: string,
  inheritedPath = process.env.PATH ?? "",
) {
  const fixtureRoot = realpathSync(directory);
  const root = join(fixtureRoot, ".local", "private-handoff");
  const storeRoot = join(root, "store");
  mkdirSync(storeRoot, { recursive: true, mode: 0o700 });
  assert.equal(realpathSync(storeRoot), storeRoot);
  const databasePath = join(storeRoot, "managed-update-handoffs.sqlite");
  const observations = join(root, "observations.jsonl");
  const preload = join(root, "preload.mjs");
  const launches = join(root, "launches.txt");
  const bin = join(root, "bin");
  const node = join(bin, "node");
  const preloadOption = `--import=${pathToFileURL(preload).href}`;
  const shellQuote = (value: string) => `'${value.replace(/'/gu, `'\\''`)}'`;
  mkdirSync(bin, { recursive: true });
  writeFileSync(launches, "");
  // The shell launch record is independent of NODE_OPTIONS. Refuse a missing
  // binding before the source helper could access an uninjected store.
  writeFileSync(
    node,
    [
      "#!/bin/sh",
      "set -eu",
      'for arg in "$@"; do',
      '  case "$arg" in',
      "    */scripts/pr-lib/worktree-provision.mts)",
      '      printf "%s\\n" "$$" >> ' + shellQuote(launches),
      '      case " ${NODE_OPTIONS-} " in *' + shellQuote(` ${preloadOption} `) + "*) ;;",
      "        *) echo 'Missing private handoff preload' >&2; exit 97 ;;",
      "      esac",
      "      break ;;",
      "  esac",
      "done",
      `exec ${shellQuote(realpathSync(process.execPath))} "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(node, 0o755);
  writeFileSync(observations, "");
  writeFileSync(
    preload,
    `
import assert from "node:assert/strict";
import { appendFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Git/GitHub stubs and the shell supervisor do not open handoff stores.
// The managed provisioner path can reach config write-lock admission.
// Native Git paths need no config write; verify injection in every helper anyway.
const entry = process.argv[1];
if (entry?.endsWith("/scripts/pr-lib/worktree-provision.mts")) {
  const sourceRoot = path.resolve(path.dirname(realpathSync(entry)), "../..");
  const storeRoot = ${JSON.stringify(storeRoot)};
  const databasePath = ${JSON.stringify(databasePath)};
  const observations = ${JSON.stringify(observations)};
  assert.equal(realpathSync(storeRoot), storeRoot);
  const require = createRequire(path.join(sourceRoot, "package.json"));
  const { resolveSecureTempRoot } = require("@openclaw/fs-safe/temp");
  const { registerSealedRuntime } = await import(
    pathToFileURL(path.join(sourceRoot, "src/infra/sealed-runtime-registry.ts")).href
  );
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
  await import(pathToFileURL(path.join(sourceRoot, "scripts/tsx.mjs")).href);
  const { createManagedHandoffLeaseStore, resolveManagedUpdateLeaseDatabasePath } = await import(
    pathToFileURL(path.join(sourceRoot, "src/infra/update-managed-service-handoff-lease.ts")).href
  );
  assert.equal(resolveManagedUpdateLeaseDatabasePath(), databasePath);
  observe("injected");
  // Verify injected production resolver/store before the helper executes. This
  // is a preflight check, not evidence of later workload access, even when provisioning
  // does not need a config write. Explicit options cannot select a live fallback.
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
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    },
    assertProvisionersInjected() {
      const rows = readFileSync(observations, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              kind: string;
              pid: number;
              sourceRoot: string;
              databasePath: string;
            },
        );
      const injected = rows.filter((row) => row.kind === "injected");
      const launched = readFileSync(launches, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(Number);
      assert.ok(launched.length > 0, "cold provisioner never launched through the private owner");
      assert.ok(launched.every((pid) => Number.isSafeInteger(pid) && pid > 0));
      assert.equal(new Set(launched).size, launched.length, "ambiguous reused provisioner PID");
      assert.deepEqual(
        injected.map((row) => row.pid).toSorted((a, b) => a - b),
        launched.toSorted((a, b) => a - b),
        "not every launched provisioner received its private store",
      );
      assert.ok(injected.length > 0, "cold provisioner never received its private store");
      for (const row of rows) {
        assert.equal(row.databasePath, databasePath);
      }
      for (const row of injected) {
        assert.ok(
          rows.some((other) => other.pid === row.pid && other.kind === "preflight-store-verified"),
          "provisioner " + row.pid + " never verified its injected private store during preflight",
        );
        assert.ok(
          rows.some((other) => other.pid === row.pid && other.kind === "preflight-resolved"),
          `provisioner ${row.pid} never preflight-verified its injected handoff store`,
        );
      }
      assert.equal(realpathSync(storeRoot), storeRoot);
    },
  };
}
