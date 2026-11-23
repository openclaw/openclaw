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

/** Hashed dist chunks first imported after SIGTERM by a module loaded before it. */
function lateChunkImports(lines: string[]) {
  return lines.flatMap((line) => {
    const [, parent, specifier, fromLoadedModule] = JSON.parse(line) as [
      number,
      string | null,
      string,
      boolean,
    ];
    // Only hashed chunks vanish in a swap. Stable entries, workers started after
    // SIGTERM, and dependencies resolve in the replacement tree.
    return fromLoadedModule &&
      !parent?.includes("/node_modules/") &&
      /^\.\.?\/(?:.*\/)?[^/]+-[\w-]{8}\.mjs$/u.test(specifier)
      ? [`${path.basename(parent ?? "")} -> ${specifier}`]
      : [];
  });
}

// Windows stops the test Gateway with taskkill, which delivers no SIGTERM to observe.
it.skipIf(process.platform === "win32")(
  "stops a built Gateway without first-importing a module after SIGTERM",
  async () => {
    const log = path.join(tempDirs.make("openclaw-late-imports-"), "late-imports.jsonl");
    instance = await createOpenClawTestInstance({
      name: "late-imports",
      // A full Gateway close needs more than the fixture's quick-stop default.
      stopTimeoutMs: 30_000,
      env: {
        NODE_OPTIONS: `--import=${probe}`,
        OPENCLAW_TEST_LATE_IMPORT_LOG: log,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      },
    });
    await instance.startGateway();
    expect(await instance.entrypoint()).toEqual([expect.stringMatching(/^dist\/index\.m?js$/u)]);
    // Retention starts independently of post-ready maintenance and loads its own worker.
    // Let both startup paths settle before measuring shutdown's first imports.
    await vi.waitFor(
      () => {
        const logs = instance?.logs();
        expect(logs).toMatch(/startup (?:phase|trace): post-ready\.startup-maintenance \d/u);
        expect(logs).toContain("Session registry maintenance completed");
      },
      { timeout: 60_000, interval: 250 },
    );
    const child = instance.child;
    await instance.stopGateway();

    expect(child?.exitCode).toBe(0);
    // The preload observed the stop signal, so an empty log is a real result.
    expect(existsSync(`${log}.sigterm`)).toBe(true);
    const lines = (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
    expect(lateChunkImports(lines)).toEqual([]);
  },
  240_000,
);
