import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createCliTtyMock } from "../cli/test-runtime-capture.js";
import { assertLegacyGatewayStoppedForMaintenance } from "../infra/gateway-lock-legacy.js";
import { readGatewayLockProcessNamespace } from "../infra/gateway-lock-payload.js";
import * as lockProcess from "../infra/gateway-lock-process.js";
import { resolveGatewayLockPaths } from "../infra/gateway-lock.js";
import type { RuntimeEnv } from "../runtime.js";
import * as processIdentity from "../shared/pid-alive.js";
import {
  assertLegacyGatewayStoppedWithDoctorRecovery,
  maybeRecoverLegacyGatewayLockForDoctor,
} from "./doctor-legacy-lock-recovery.js";

const confirmMock = vi.fn();
const selectMock = vi.fn();

vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  confirm: (options: unknown) => confirmMock(options),
  select: (options: unknown) => selectMock(options),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const ttyMock = createCliTtyMock([process.stdin]);

afterEach(() => {
  vi.resetAllMocks();
  ttyMock.restore();
  vi.unstubAllEnvs();
});

function makeRuntime(): RuntimeEnv & { log: ReturnType<typeof vi.fn> } {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

function fixture(layout: "covered" | "system-temp") {
  const root = tempDirs.make("doctor-legacy-lock-recovery-");
  const stateDir = path.join(root, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const env = process.env;
  const paths = resolveGatewayLockPaths(env);
  const lockDir = path.dirname(paths.configLockPath);
  vi.spyOn(os, "tmpdir").mockReturnValue(
    layout === "covered" ? path.dirname(lockDir) : path.join(root, "sys-tmp"),
  );
  const uid = process.getuid?.();
  const legacyDir =
    layout === "covered"
      ? lockDir
      : path.join(os.tmpdir(), uid === undefined ? "openclaw" : `openclaw-${uid}`);
  const legacyPath = resolveGatewayLockPaths(env, legacyDir).configLockPath;
  if (layout === "covered") {
    expect(legacyPath).toBe(paths.configLockPath);
  }
  return { env, paths, legacyPath };
}

function writeRecord(legacyPath: string, record: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(legacyPath, JSON.stringify(record));
}

describe("doctor legacy-lock recovery", () => {
  it("recovers a covered legacy lock after confirmation, then admits maintenance", async () => {
    const { env, legacyPath } = fixture("covered");
    ttyMock.set(true);
    writeRecord(legacyPath, {
      pid: 2_147_483_647,
      startTime: 123,
      createdAt: "2026-09-30T18:22:02.990Z",
      configPath: env.OPENCLAW_CONFIG_PATH,
    });
    await expect(assertLegacyGatewayStoppedForMaintenance(env)).rejects.toThrow(
      "live or unverified owner",
    );
    confirmMock.mockResolvedValue(true);
    const runtime = makeRuntime();
    await expect(
      maybeRecoverLegacyGatewayLockForDoctor({
        env,
        options: { repair: true },
        runtime,
      }),
    ).resolves.toBe(true);
    expect(confirmMock).toHaveBeenCalledOnce();
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(runtime.log.mock.calls.join("\n")).toContain("openclaw gateway recover-lock --confirm ");
    await expect(assertLegacyGatewayStoppedForMaintenance(env)).resolves.toBeUndefined();
  });

  it("keeps the record when the operator declines", async () => {
    const { env, legacyPath } = fixture("covered");
    ttyMock.set(true);
    writeRecord(legacyPath, {
      pid: 2_147_483_647,
      createdAt: "2026-09-30T18:22:02.990Z",
      configPath: env.OPENCLAW_CONFIG_PATH,
    });
    confirmMock.mockResolvedValue(false);
    const runtime = makeRuntime();
    await expect(
      maybeRecoverLegacyGatewayLockForDoctor({
        env,
        options: { repair: true },
        runtime,
      }),
    ).resolves.toBe(false);
    expect(fs.existsSync(legacyPath)).toBe(true);
  });

  it("keeps the refusal for a record outside inspection without prompting", async () => {
    const { env, legacyPath } = fixture("system-temp");
    ttyMock.set(true);
    writeRecord(legacyPath, {
      pid: 2_147_483_647,
      createdAt: "2026-09-30T18:22:02.990Z",
      configPath: env.OPENCLAW_CONFIG_PATH,
    });
    await expect(assertLegacyGatewayStoppedForMaintenance(env)).rejects.toThrow(
      "live or unverified owner",
    );
    confirmMock.mockResolvedValue(true);
    await expect(
      maybeRecoverLegacyGatewayLockForDoctor({
        env,
        options: { repair: true },
        runtime: makeRuntime(),
      }),
    ).resolves.toBe(false);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(fs.existsSync(legacyPath)).toBe(true);
  });

  it("keeps a live holder and reports the recovery failure", async () => {
    const { env, legacyPath } = fixture("covered");
    ttyMock.set(true);
    const localNamespace = readGatewayLockProcessNamespace();
    if (!localNamespace) {
      throw new Error("Recovery fixture requires the local process namespace");
    }
    writeRecord(legacyPath, {
      pid: 424_242,
      startTime: 12_345,
      createdAt: "2026-09-30T18:22:02.990Z",
      configPath: env.OPENCLAW_CONFIG_PATH,
      processNamespace: localNamespace,
    });
    vi.spyOn(processIdentity, "isPidAlive").mockReturnValue(true);
    vi.spyOn(lockProcess, "readGatewayLockProcessStartTime").mockReturnValue(12_345);
    await expect(assertLegacyGatewayStoppedForMaintenance(env)).rejects.toThrow(
      "live or unverified owner",
    );
    confirmMock.mockResolvedValue(true);
    const runtime = makeRuntime();
    await expect(
      maybeRecoverLegacyGatewayLockForDoctor({
        env,
        options: { repair: true },
        runtime,
      }),
    ).resolves.toBe(false);
    expect(fs.existsSync(legacyPath)).toBe(true);
    expect(runtime.error.mock.calls.join("\n")).toContain("still live");
  });

  it("retries admission when the record vanished without prompting", async () => {
    const { env } = fixture("covered");
    ttyMock.set(true);
    confirmMock.mockResolvedValue(true);
    await expect(
      maybeRecoverLegacyGatewayLockForDoctor({
        env,
        options: { repair: true },
        runtime: makeRuntime(),
      }),
    ).resolves.toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("admits without prompting when no legacy lock blocks maintenance", async () => {
    const { env } = fixture("covered");
    ttyMock.set(true);
    confirmMock.mockResolvedValue(true);
    await expect(
      assertLegacyGatewayStoppedWithDoctorRecovery({
        env,
        options: { repair: true },
        runtime: makeRuntime(),
      }),
    ).resolves.toBeUndefined();
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("recovers and admits after confirmation", async () => {
    const { env, legacyPath } = fixture("covered");
    ttyMock.set(true);
    writeRecord(legacyPath, {
      pid: 2_147_483_647,
      createdAt: "2026-09-30T18:22:02.990Z",
      configPath: env.OPENCLAW_CONFIG_PATH,
    });
    confirmMock.mockResolvedValue(true);
    await expect(
      assertLegacyGatewayStoppedWithDoctorRecovery({
        env,
        options: { repair: true },
        runtime: makeRuntime(),
      }),
    ).resolves.toBeUndefined();
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it("rethrows the original refusal when the operator declines", async () => {
    const { env, legacyPath } = fixture("covered");
    ttyMock.set(true);
    writeRecord(legacyPath, {
      pid: 2_147_483_647,
      createdAt: "2026-09-30T18:22:02.990Z",
      configPath: env.OPENCLAW_CONFIG_PATH,
    });
    confirmMock.mockResolvedValue(false);
    await expect(
      assertLegacyGatewayStoppedWithDoctorRecovery({
        env,
        options: { repair: true },
        runtime: makeRuntime(),
      }),
    ).rejects.toThrow("live or unverified owner");
    expect(fs.existsSync(legacyPath)).toBe(true);
  });

  it.each([
    { name: "without a TTY", tty: false, options: { repair: true }, update: false },
    { name: "during an update", tty: true, options: { repair: true }, update: true },
    { name: "for JSON output", tty: true, options: { repair: true, json: true }, update: false },
    { name: "with --yes", tty: true, options: { repair: true, yes: true }, update: false },
    {
      name: "when non-interactive",
      tty: true,
      options: { repair: true, nonInteractive: true },
      update: false,
    },
  ])("stays silent $name", async ({ tty, options, update }) => {
    const { env, legacyPath } = fixture("covered");
    ttyMock.set(tty);
    if (update) {
      vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
    }
    writeRecord(legacyPath, {
      pid: 2_147_483_647,
      createdAt: "2026-09-30T18:22:02.990Z",
      configPath: env.OPENCLAW_CONFIG_PATH,
    });
    confirmMock.mockResolvedValue(true);
    await expect(
      maybeRecoverLegacyGatewayLockForDoctor({ env, options, runtime: makeRuntime() }),
    ).resolves.toBe(false);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(fs.existsSync(legacyPath)).toBe(true);
  });
});
