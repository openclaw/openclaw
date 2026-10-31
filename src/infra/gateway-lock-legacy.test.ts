import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as processIdentity from "../shared/pid-alive.js";
import { assertLegacyGatewayStoppedForMaintenance } from "./gateway-lock-legacy.js";
import { GATEWAY_OWNER_HEARTBEAT_STALE_MS } from "./gateway-lock-payload.js";
import { resolveGatewayLockPaths } from "./gateway-lock.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each([
  { owner: "exited", dead: true, startTime: null, expired: true, admit: true },
  { owner: "reused", dead: false, startTime: 124, expired: true, admit: true },
  { owner: "live", dead: false, startTime: 123, expired: true, admit: false },
  { owner: "unverifiable", dead: false, startTime: null, expired: true, admit: false },
  { owner: "recently exited", dead: true, startTime: null, expired: false, admit: false },
])("admits legacy Windows maintenance only for a provably stopped $owner owner", async (test) => {
  const root = tempDirs.make("gateway-legacy-maintenance-");
  vi.spyOn(os, "tmpdir").mockReturnValue(root);
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
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
  const stamp = new Date(Date.now() - (test.expired ? GATEWAY_OWNER_HEARTBEAT_STALE_MS + 1000 : 0));
  fs.utimesSync(configLockPath, stamp, stamp);

  const admission = assertLegacyGatewayStoppedForMaintenance(env);
  if (test.admit) {
    await expect(admission).resolves.toBeUndefined();
  } else {
    await expect(admission).rejects.toThrow("live or unverified owner");
  }
  expect(fs.readFileSync(configLockPath, "utf8")).toBe(record);
});
