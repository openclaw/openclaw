import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import {
  gatewayLockOwnerIsLocalProcessNamespace,
  readGatewayLockProcessNamespace,
} from "./gateway-lock-payload.js";
import { isGatewayStateOwnerDefinitelyStale } from "./gateway-state-owner-record.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function writeLock(directory: string): string {
  const pathname = path.join(directory, "state.lock");
  fs.writeFileSync(pathname, "{}\n");
  return pathname;
}

function currentNamespace() {
  const current = readGatewayLockProcessNamespace();
  if (current === null) {
    throw new Error("Expected a readable process namespace");
  }
  return current;
}

function namespaceWith(overrides: Record<string, unknown>) {
  return { ...currentNamespace(), ...overrides };
}

/** A different boot identity that still satisfies every platform's identity format. */
function conflictingBootIdentity(): string {
  const { identity } = currentNamespace();
  return identity.slice(0, -1) + (identity.endsWith("0") ? "1" : "0");
}

function liveOwner(overrides: Record<string, unknown> = {}) {
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

it("keeps a live owner whose recorded boot identity disagrees", () => {
  const directory = tempDirs.make("state-owner-boot-identity-");
  const pathname = writeLock(directory);
  const payload = liveOwner({
    processNamespace: namespaceWith({ identity: conflictingBootIdentity() }),
  });

  expect(isGatewayStateOwnerDefinitelyStale(payload, pathname)).toBe(false);
});

it("reclaims an owner whose recorded process exited", async () => {
  const directory = tempDirs.make("state-owner-exited-");
  const pathname = writeLock(directory);
  const payload = {
    pid: await exitedPid(),
    startTime: undefined,
    role: "gateway",
    processNamespace: namespaceWith({ identity: conflictingBootIdentity() }),
  };

  expect(isGatewayStateOwnerDefinitelyStale(payload, pathname)).toBe(true);
});

it("reclaims a live pid whose recorded start identity changed", () => {
  const directory = tempDirs.make("state-owner-pid-reuse-");
  const pathname = writeLock(directory);
  const startTime = (getFileLockProcessStartTime(process.pid) ?? 0) + 12_345;
  const payload = liveOwner({
    startTime,
    processNamespace: namespaceWith({ identity: conflictingBootIdentity() }),
  });

  expect(isGatewayStateOwnerDefinitelyStale(payload, pathname)).toBe(true);
});

it("treats a foreign host as outside local process evidence", () => {
  expect(
    gatewayLockOwnerIsLocalProcessNamespace(namespaceWith({ host: "not-this-host.invalid" })),
  ).toBe(false);
  expect(gatewayLockOwnerIsLocalProcessNamespace(currentNamespace())).toBe(true);
});
