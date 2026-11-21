// Built Gateway shutdown must not first-import modules: an in-place update replaces
// hashed dist chunks under the running process (#160674, #185730).
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../helpers/openclaw-test-instance.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const probe = fileURLToPath(new URL("../helpers/gateway-late-import-probe.mjs", import.meta.url));
let instance: OpenClawTestInstance | undefined;
afterEach(async () => {
  await instance?.cleanup();
  instance = undefined;
});

/** Imports whose importer was loaded before SIGTERM; a new chain is reported once, by its root. */
function lateImportRoots(lines: string[]) {
  const entries = lines.map((line) => JSON.parse(line) as [number, string | null, string]);
  // Workers started after SIGTERM load their stable-named entry from the replacement tree.
  const lateThreads = new Set(entries.filter(([, parent]) => parent === null).map(([t]) => t));
  const lateModules = new Set(
    entries.flatMap(([thread, parent, specifier]) =>
      parent && /^\.\.?\//u.test(specifier) ? [`${thread} ${new URL(specifier, parent).href}`] : [],
    ),
  );
  return entries
    .filter(
      ([thread, parent, specifier]) =>
        parent !== null &&
        !lateThreads.has(thread) &&
        // Dependencies resolve by package name in the replacement tree.
        /^\.\.?\//u.test(specifier) &&
        !lateModules.has(`${thread} ${parent}`),
    )
    .map(([, parent, specifier]) => `${path.basename(parent ?? "")} -> ${specifier}`);
}

it("stops a built Gateway without first-importing a module after SIGTERM", async () => {
  const log = path.join(tempDirs.make("openclaw-late-imports-"), "late-imports.jsonl");
  instance = await createOpenClawTestInstance({
    name: "late-imports",
    env: {
      NODE_OPTIONS: `--import=${probe}`,
      OPENCLAW_TEST_LATE_IMPORT_LOG: log,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
    },
  });
  await instance.startGateway();
  expect(await instance.entrypoint()).toEqual([expect.stringMatching(/^dist\/index\.m?js$/u)]);
  const child = instance.child;
  await instance.stopGateway();

  expect(child?.exitCode).toBe(0);
  // The preload observed the stop signal, so an empty log is a real result.
  expect(existsSync(`${log}.sigterm`)).toBe(true);
  const lines = (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
  expect(lateImportRoots(lines)).toEqual([]);
}, 240_000);
