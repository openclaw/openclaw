import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import {
  GatewayLockError,
  readActiveGatewayLockIdentity,
  readActiveGatewayLockPort,
} from "./gateway-lock.js";

const fixtureRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-gateway-lock-inspect-" });

async function makeEnv() {
  const dir = await fixtureRootTracker.make("case");
  const configPath = path.join(dir, "openclaw.json");
  await fs.writeFile(configPath, "{}", "utf8");
  return {
    ...process.env,
    OPENCLAW_STATE_DIR: dir,
    OPENCLAW_CONFIG_PATH: configPath,
  };
}

function resolveLockPaths(env: NodeJS.ProcessEnv) {
  const stateDir = resolveStateDir(env);
  const configPath = resolveConfigPath(env, stateDir);
  const configHash = createHash("sha256").update(configPath).digest("hex").slice(0, 8);
  const lockDir = path.join(stateDir, "__locks");
  return {
    lockDir,
    lockPath: path.join(lockDir, `gateway.${configHash}.lock`),
    stateLockPath: path.join(lockDir, "gateway.state.lock"),
    configPath,
  };
}

describe("gateway lock inspection", () => {
  beforeAll(async () => {
    await fixtureRootTracker.setup();
  });

  afterAll(async () => {
    await fixtureRootTracker.cleanup();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { state: "missing", file: "config", expected: "absent" },
    { state: "dead", file: "config", expected: "absent" },
    { state: "other role", file: "state", expected: "absent" },
    { state: "active", file: "state", expected: "active" },
    { state: "missing port", file: "config", expected: "unavailable" },
    ...["config", "state"].flatMap((file) =>
      ["corrupt", "unreadable", "unknown owner"].map((state) => ({
        state,
        file,
        expected: "unavailable",
      })),
    ),
  ])(
    "preserves strict lock inspection for $state $file locks without changing discovery",
    async ({ state, file, expected }) => {
      const env = await makeEnv();
      const { lockDir, lockPath, stateLockPath, configPath } = resolveLockPaths(env);
      await fs.mkdir(lockDir, { recursive: true });
      const target = file === "state" ? stateLockPath : lockPath;
      if (state !== "missing") {
        const payload = {
          pid: process.pid,
          createdAt: new Date().toISOString(),
          configPath,
          startTime: 111,
          ...(state !== "missing port" ? { port: 48789 } : {}),
          ...(state === "other role" ? { role: "sqlite-maintenance" as const } : {}),
        };
        await fs.writeFile(target, state === "corrupt" ? "{" : JSON.stringify(payload));
      }
      if (state === "unreadable") {
        const readFile = fs.readFile;
        vi.spyOn(fs, "readFile").mockImplementation(async (filePath, options) => {
          if (filePath === target) {
            throw Object.assign(new Error("permission denied"), { code: "EACCES" });
          }
          return readFile(filePath, options);
        });
      }
      const options = {
        env,
        lockDir,
        platform: "linux" as const,
        readProcessStartTime: () => (state === "dead" ? 222 : null),
        readProcessCmdline: () => (state === "unknown owner" ? null : ["openclaw-gateway"]),
      };
      await expect(readActiveGatewayLockPort(options)).resolves.toBe(
        expected === "active" ? 48789 : undefined,
      );
      const strict = readActiveGatewayLockIdentity({ ...options, requireInspection: true });
      if (expected === "unavailable") {
        await expect(strict).rejects.toBeInstanceOf(GatewayLockError);
      } else if (expected === "active") {
        await expect(strict).resolves.toMatchObject({ pid: process.pid, port: 48789 });
      } else {
        await expect(strict).resolves.toBeUndefined();
      }
    },
  );
});
