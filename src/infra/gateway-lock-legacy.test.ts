import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as processIdentity from "../shared/pid-alive.js";
import { assertLegacyGatewayStoppedForMaintenance } from "./gateway-lock-legacy.js";
import { GATEWAY_OWNER_HEARTBEAT_STALE_MS } from "./gateway-lock-payload.js";
import { resolveGatewayLockPaths } from "./gateway-lock.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

// A Linux PID may belong to a container in another PID namespace sharing this directory.
const platforms = [
  { platform: "win32", provable: true },
  { platform: "darwin", provable: true },
  { platform: "linux", provable: false },
] as const;
const owners = [
  { owner: "exited", dead: true, startTime: null, expired: true, stopped: true },
  { owner: "reused", dead: false, startTime: 124, expired: true, stopped: true },
  { owner: "live", dead: false, startTime: 123, expired: true, stopped: false },
  { owner: "unverifiable", dead: false, startTime: null, expired: true, stopped: false },
  { owner: "recently exited", dead: true, startTime: null, expired: false, stopped: false },
];

describe.each(platforms)("legacy $platform maintenance", ({ platform, provable }) => {
  it.each(owners)("admits a $owner owner only when provably stopped", async (test) => {
    const root = tempDirs.make("gateway-legacy-maintenance-");
    vi.spyOn(os, "tmpdir").mockReturnValue(root);
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    vi.spyOn(processIdentity, "isPidDefinitelyDead").mockReturnValue(test.dead);
    vi.spyOn(processIdentity, "getFileLockProcessStartTime").mockReturnValue(test.startTime);
    const env = {
      HOME: root,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    };
    const uid = process.getuid?.();
    const lockDir = path.join(root, uid === undefined ? "openclaw" : `openclaw-${uid}`);
    const { configLockPath } = resolveGatewayLockPaths(env, lockDir);
    fs.mkdirSync(lockDir, { recursive: true });
    const record = JSON.stringify({
      pid: 2_147_483_647,
      startTime: 123,
      createdAt: "2026-06-01T00:00:00.000Z",
      configPath: env.OPENCLAW_CONFIG_PATH,
    });
    fs.writeFileSync(configLockPath, record);
    const stamp = new Date(
      Date.now() - (test.expired ? GATEWAY_OWNER_HEARTBEAT_STALE_MS + 1000 : 0),
    );
    fs.utimesSync(configLockPath, stamp, stamp);

    const admission = assertLegacyGatewayStoppedForMaintenance(env);
    if (provable && test.stopped) {
      await expect(admission).resolves.toBeUndefined();
    } else {
      await expect(admission).rejects.toThrow("live or unverified owner");
      await expect(admission).rejects.toThrow("remove that file as the Gateway service account");
    }
    expect(fs.readFileSync(configLockPath, "utf8")).toBe(record);
  });
});
