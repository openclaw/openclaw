import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfigPath, resolveGatewayLockDir, resolveStateDir } from "../config/paths.js";
import { captureEnv } from "../test-utils/env.js";

const note = vi.hoisted(() => vi.fn());

vi.mock("../terminal/note.js", () => ({
  note,
}));

import { noteGatewayLockHealth } from "./doctor-gateway-locks.js";

function resolveLockPath(env: NodeJS.ProcessEnv) {
  const stateDir = resolveStateDir(env);
  const configPath = resolveConfigPath(env, stateDir);
  const hash = createHash("sha256").update(configPath).digest("hex").slice(0, 8);
  return {
    lockPath: path.join(resolveGatewayLockDir(), `gateway.${hash}.lock`),
    configPath,
  };
}

describe("noteGatewayLockHealth", () => {
  let root: string;
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(async () => {
    note.mockClear();
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-gateway-lock-"));
    process.env.OPENCLAW_STATE_DIR = root;
    process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
    await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH, "{}", "utf8");
    await fs.mkdir(resolveGatewayLockDir(), { recursive: true });
  });

  afterEach(async () => {
    envSnapshot.restore();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reports existing gateway lock with pid status and age", async () => {
    const { lockPath, configPath } = resolveLockPath(process.env);
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        createdAt: new Date(Date.now() - 1_500).toISOString(),
        configPath,
      }),
      "utf8",
    );

    await noteGatewayLockHealth({ shouldRepair: false, staleMs: 60_000 });

    expect(note).toHaveBeenCalledTimes(1);
    const [message, title] = note.mock.calls[0] as [string, string];
    expect(title).toBe("Gateway lock");
    expect(message).toContain("Found gateway lock file");
    expect(message).toContain(`pid=${process.pid} (alive)`);
    expect(message).toContain("stale=no");
    await expect(fs.access(lockPath)).resolves.toBeUndefined();
  });

  it("removes stale gateway lock in repair mode", async () => {
    const { lockPath, configPath } = resolveLockPath(process.env);
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: -1,
        createdAt: new Date(Date.now() - 120_000).toISOString(),
        configPath,
      }),
      "utf8",
    );

    await noteGatewayLockHealth({ shouldRepair: true, staleMs: 30_000 });

    expect(note).toHaveBeenCalledTimes(1);
    const [message, title] = note.mock.calls[0] as [string, string];
    expect(title).toBe("Gateway lock");
    expect(message).toContain("[removed]");
    expect(message).toContain("Removed stale gateway lock file");
    await expect(fs.access(lockPath)).rejects.toThrow();
  });
});
