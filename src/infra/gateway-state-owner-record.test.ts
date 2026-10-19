import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";

const classification = vi.hoisted(() => ({
  verdict: "same" as "same" | "dead" | "unknown",
  windowsSameHost: false,
}));

// The predicate consumes these two classification owners; the decision table below is
// what this change adds, while the classifier itself is covered by its own tests.
vi.mock("./gateway-lock-payload.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gateway-lock-payload.js")>()),
  classifyGatewayLockProcessNamespace: () => classification.verdict,
  gatewayLockOwnerIsSameHostWindowsNamespace: () => classification.windowsSameHost,
}));

import { isGatewayStateOwnerDefinitelyStale } from "./gateway-state-owner-record.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const WINDOWS_BOOT = {
  platform: "win32" as const,
  host: "test-host",
  identity: "2026-10-18T00:00:00.0000000Z",
};
const LINUX_BOOT = {
  platform: "linux" as const,
  host: "test-host",
  identity: "8f14e45f-ceea-467a-9c1f-0f5e0e6a3f31",
  pidNsInode: "1",
};

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
    processNamespace: WINDOWS_BOOT,
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

afterEach(() => {
  classification.verdict = "same";
  classification.windowsSameHost = false;
});

it("keeps a live Windows owner whose recorded boot identity disagrees", () => {
  classification.verdict = "dead";
  classification.windowsSameHost = true;
  const pathname = writeLock(tempDirs.make("state-owner-win-live-"));

  expect(isGatewayStateOwnerDefinitelyStale(payload(), pathname)).toBe(false);
});

it("keeps reclaiming a previous Linux boot with a live local pid", () => {
  classification.verdict = "dead";
  classification.windowsSameHost = false;
  const pathname = writeLock(tempDirs.make("state-owner-linux-boot-"));

  expect(
    isGatewayStateOwnerDefinitelyStale(
      payload({
        processNamespace: {
          ...LINUX_BOOT,
          identity: "8f14e45f-ceea-467a-9c1f-0f5e0e6a3f32",
        },
      }),
      pathname,
    ),
  ).toBe(true);
});

it("keeps reclaiming a Windows record without a recorded start identity", () => {
  classification.verdict = "dead";
  classification.windowsSameHost = true;
  const pathname = writeLock(tempDirs.make("state-owner-win-no-start-"));

  expect(isGatewayStateOwnerDefinitelyStale(payload({ startTime: undefined }), pathname)).toBe(
    true,
  );
});

it("reclaims a Windows owner whose recorded process exited", async () => {
  classification.verdict = "dead";
  classification.windowsSameHost = true;
  const pathname = writeLock(tempDirs.make("state-owner-win-exited-"));

  expect(
    isGatewayStateOwnerDefinitelyStale(
      payload({ pid: await exitedPid(), startTime: undefined }),
      pathname,
    ),
  ).toBe(true);
});

it("reclaims a Windows pid whose recorded start identity changed", () => {
  classification.verdict = "dead";
  classification.windowsSameHost = true;
  const pathname = writeLock(tempDirs.make("state-owner-win-pid-reuse-"));

  expect(
    isGatewayStateOwnerDefinitelyStale(
      payload({ startTime: (getFileLockProcessStartTime(process.pid) ?? 0) + 12_345 }),
      pathname,
    ),
  ).toBe(true);
});

it("keeps a live owner when the classification is not dead", () => {
  classification.verdict = "same";
  const pathname = writeLock(tempDirs.make("state-owner-not-dead-"));

  expect(isGatewayStateOwnerDefinitelyStale(payload(), pathname)).toBe(false);
});

it("refuses to decide when the namespace cannot be classified", () => {
  classification.verdict = "unknown";
  const pathname = writeLock(tempDirs.make("state-owner-unknown-"));

  expect(() => isGatewayStateOwnerDefinitelyStale(payload(), pathname)).toThrow(
    /cannot verify Gateway ownership/,
  );
});
