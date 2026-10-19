import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { isGatewayStateOwnerDefinitelyStale } from "./gateway-state-owner-record.js";

const namespaceState = vi.hoisted(() => ({
  value: null as Record<string, unknown> | null,
}));

// The classification owner is mocked so a Windows boot-identity disagreement and a
// Linux previous-boot verdict can both be exercised unchanged on any test host.
vi.mock("./gateway-lock-payload.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gateway-lock-payload.js")>()),
  readGatewayLockProcessNamespace: () => namespaceState.value,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const WINDOWS_BOOT = "2026-10-18T00:00:00.0000000Z";
const OTHER_WINDOWS_BOOT = "2026-10-18T00:00:00.0000001Z";
const LINUX_BOOT = "8f14e45f-ceea-467a-9c1f-0f5e0e6a3f31";
const OTHER_LINUX_BOOT = "8f14e45f-ceea-467a-9c1f-0f5e0e6a3f32";

function windowsNamespace(overrides: Record<string, unknown> = {}) {
  return { platform: "win32", host: "test-host", identity: WINDOWS_BOOT, ...overrides };
}

function writeLock(directory: string, ageMs = 0): string {
  const pathname = path.join(directory, "state.lock");
  fs.writeFileSync(pathname, "{}\n");
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(pathname, when, when);
  }
  return pathname;
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    pid: process.pid,
    startTime: getFileLockProcessStartTime(process.pid),
    role: "gateway",
    ...overrides,
  };
}

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error("Expected a child process id");
  }
  await once(child, "exit");
  return pid;
}

beforeEach(() => {
  namespaceState.value = windowsNamespace();
});

it("keeps a live Windows owner whose recorded boot identity disagrees", () => {
  const pathname = writeLock(tempDirs.make("state-owner-win-live-"));
  const value = payload({
    processNamespace: windowsNamespace({ identity: OTHER_WINDOWS_BOOT }),
  });

  expect(isGatewayStateOwnerDefinitelyStale(value, pathname)).toBe(false);
});

it("keeps reclaiming a previous Linux boot with a live local pid", () => {
  namespaceState.value = {
    platform: "linux",
    host: "test-host",
    identity: LINUX_BOOT,
    pidNsInode: "1",
  };
  const pathname = writeLock(tempDirs.make("state-owner-linux-boot-"));
  const value = payload({
    processNamespace: { ...namespaceState.value, identity: OTHER_LINUX_BOOT },
  });

  expect(isGatewayStateOwnerDefinitelyStale(value, pathname)).toBe(true);
});

it("keeps reclaiming a Windows record without a recorded start identity", () => {
  const pathname = writeLock(tempDirs.make("state-owner-win-no-start-"));
  const value = payload({
    startTime: undefined,
    processNamespace: windowsNamespace({ identity: OTHER_WINDOWS_BOOT }),
  });

  expect(isGatewayStateOwnerDefinitelyStale(value, pathname)).toBe(true);
});

it("reclaims a Windows owner whose recorded process exited", async () => {
  const pathname = writeLock(tempDirs.make("state-owner-win-exited-"));
  const value = {
    pid: await exitedPid(),
    startTime: undefined,
    role: "gateway",
    processNamespace: windowsNamespace({ identity: OTHER_WINDOWS_BOOT }),
  };

  expect(isGatewayStateOwnerDefinitelyStale(value, pathname)).toBe(true);
});

it("reclaims a Windows pid whose recorded start identity changed", () => {
  const pathname = writeLock(tempDirs.make("state-owner-win-pid-reuse-"));
  const value = payload({
    startTime: (getFileLockProcessStartTime(process.pid) ?? 0) + 12_345,
    processNamespace: windowsNamespace({ identity: OTHER_WINDOWS_BOOT }),
  });

  expect(isGatewayStateOwnerDefinitelyStale(value, pathname)).toBe(true);
});

it("reclaims an expired foreign-namespace owner while a local pid is alive", () => {
  const pathname = writeLock(tempDirs.make("state-owner-foreign-"), 5 * 60_000);
  const value = payload({
    processNamespace: windowsNamespace({
      host: "other-host.invalid",
      identity: OTHER_WINDOWS_BOOT,
    }),
  });

  expect(isGatewayStateOwnerDefinitelyStale(value, pathname)).toBe(true);
});
