import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { gatewayDirectStopEntrypoints } from "../cli/cli-entrypoint.test-support.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const fixture = resolveRuntimeWorkerUrl(gatewayDirectStopEntrypoints.startupOrphanFixture);
let stateRoot: string;

beforeAll(async () => {
  stateRoot = fs.realpathSync.native(tempDirs.make("openclaw-startup-orphan-"));
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: stateRoot,
    OPENCLAW_CONFIG_PATH: path.join(stateRoot, "openclaw.json"),
  };
  for (const mode of ["predecessor", "successor"]) {
    await promisify(execFile)(process.execPath, [...resolveRuntimeWorkerArgv(fixture), mode], {
      env,
      timeout: 60000,
    });
  }
}, 120000);

it.each(["default", "shared", "embedded"])(
  "recovers only ownerless predecessor rows in %s state",
  (layout) => {
    const stateDir = path.join(stateRoot, layout);
    const read = (mode: string) =>
      JSON.parse(fs.readFileSync(path.join(stateDir, mode + ".json"), "utf8"));
    const predecessor = read("predecessor");
    expect(() => process.kill(predecessor.pid, 0)).toThrow();
    const result = read(layout === "embedded" ? "embedded" : "successor");
    const before = read("before-startup");
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
        expect(orphan.endedAt).toBeGreaterThan(original.startedAt);
        expect(orphan.runtimeMs).toBeUndefined();
      }
    }
  },
  120000,
);
