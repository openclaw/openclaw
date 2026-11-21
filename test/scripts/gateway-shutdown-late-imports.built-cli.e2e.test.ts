// Built Gateway shutdown must not first-import modules: an in-place update replaces
// hashed dist chunks under the running process (#160674, #185730).
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
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

/** Imports first resolved after SIGTERM by a module loaded before it (a new chain's root). */
function lateImportRoots(lines: string[]) {
  return lines.flatMap((line) => {
    const [, parent, specifier, fromLoadedModule] = JSON.parse(line) as [
      number,
      string | null,
      string,
      boolean,
    ];
    // Dependencies resolve by package name in the replacement tree, and workers
    // started after SIGTERM load their stable-named entry from it.
    return fromLoadedModule && /^\.\.?\//u.test(specifier)
      ? [`${path.basename(parent ?? "")} -> ${specifier}`]
      : [];
  });
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
  // Startup work still loading at SIGTERM is not shutdown's import; stop after it settles.
  await vi.waitFor(
    () =>
      expect(instance?.logs()).toMatch(
        /startup (?:phase|trace): post-ready\.startup-maintenance \d/u,
      ),
    { timeout: 60_000, interval: 250 },
  );
  const child = instance.child;
  await instance.stopGateway();

  expect(child?.exitCode).toBe(0);
  // The preload observed the stop signal, so an empty log is a real result.
  expect(existsSync(`${log}.sigterm`)).toBe(true);
  const lines = (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
  expect(lateImportRoots(lines)).toEqual([]);
}, 240_000);
