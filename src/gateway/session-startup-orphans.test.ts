import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const fixturePath = fileURLToPath(
  new URL("./startup-orphan-process.test-support.ts", import.meta.url),
);
it.each(["default", "shared", "embedded"])(
  "recovers only ownerless predecessor rows in %s state",
  async (layout) => {
    const stateDir = fs.realpathSync.native(tempDirs.make("openclaw-startup-orphan-"));
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    };
    const run = async (mode: string) => {
      await promisify(execFile)(process.execPath, ["--import", "tsx", fixturePath, mode, layout], {
        env,
        timeout: 60000,
      });
      return JSON.parse(fs.readFileSync(path.join(stateDir, mode + ".json"), "utf8"));
    };
    const predecessor = await run("predecessor");
    expect(() => process.kill(predecessor.pid, 0)).toThrow();
    const result = await run(layout === "embedded" ? "embedded" : "successor");
    const before = JSON.parse(fs.readFileSync(path.join(stateDir, "before-startup.json"), "utf8"));
    expect(result.pid).not.toBe(predecessor.pid);
    const { running: mainOrphan, "ops-running": opsOrphan, ...controls } = result.rows;
    const { running: mainOriginal, "ops-running": opsOriginal, ...originalControls } = before.rows;
    expect(controls).toEqual(originalControls);
    expect(result.owners).toEqual(before.owners);
    for (const [orphan, original] of [
      [mainOrphan, mainOriginal],
      [opsOrphan, opsOriginal],
    ]) {
      if (layout === "embedded") {
        expect(orphan).toEqual(original);
      } else {
        expect(orphan.status).toBe("interrupted");
        expect(orphan.sessionId).toBe(original.sessionId);
        expect(orphan.lifecycleRevision).toBe(original.lifecycleRevision);
        expect(orphan.updatedAt).toBe(original.updatedAt);
        expect(orphan.startedAt).toBe(original.startedAt);
        expect(orphan.endedAt).toBeUndefined();
        expect(orphan.runtimeMs).toBeUndefined();
      }
    }
  },
  120000,
);
