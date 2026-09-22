import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// Node CI shards do not provision Bun; selecting BUN_BIN requires real runtime proof.
describe.runIf(Boolean(process.env.BUN_BIN))("Bun desktop WebSocket transport", () => {
  it.each(["observer-close", "observer-backpressure", "observer-payload", "desktop", "portal"])(
    "preserves %s through the registered upgrade handler",
    async (mode) => {
      const root = tempDirs.make("desktop-websocket-runtime-");
      const fixture = new URL("./websocket-runtime.test-support.ts", import.meta.url).href;
      const { stdout } = await execFileAsync(
        process.env.BUN_BIN!,
        [
          "--no-env-file",
          "--no-install",
          "--eval",
          `import assert from "node:assert/strict";
import { runDesktopWebSocketRuntimeProbe } from ${JSON.stringify(fixture)};
assert.ok(process.versions.bun, "This regression requires the real Bun runtime");
await runDesktopWebSocketRuntimeProbe(${JSON.stringify(mode)});
console.log(${JSON.stringify(`desktop-runtime-ok:${mode}`)});`,
        ],
        {
          cwd: root,
          env: { PATH: process.env.PATH, HOME: root, OPENCLAW_STATE_DIR: root },
          timeout: 10_000,
        },
      );
      expect(stdout).toContain(`desktop-runtime-ok:${mode}`);
    },
    15_000,
  );
});
