import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { heartbeatRunnerTelegramPlugin } from "../../test/helpers/infra/heartbeat-runner-channel-plugins.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { listSessionEntries, upsertSessionEntry } from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import type { HeartbeatDeps } from "./heartbeat-runner.js";

type HeartbeatSessionSeed = {
  sessionId?: string;
  updatedAt?: number;
  lastChannel: string;
  lastProvider: string;
  lastTo: string;
  agentHarnessId?: string;
  agentRuntimeOverride?: string;
  model?: string;
  modelProvider?: string;
};

type HeartbeatReplyFn = NonNullable<HeartbeatDeps["getReplyFromConfig"]>;
export type HeartbeatReplySpy = ReturnType<typeof vi.fn<HeartbeatReplyFn>>;

function createHeartbeatReplySpy(): HeartbeatReplySpy {
  const replySpy: HeartbeatReplySpy = vi.fn<HeartbeatReplyFn>();
  replySpy.mockResolvedValue({ text: "ok" });
  return replySpy;
}

export async function seedHeartbeatSession(
  agentId: string,
  sessionKey: string,
  session: HeartbeatSessionSeed,
): Promise<void> {
  await seedHeartbeatSessionRows(agentId, {
    [sessionKey]: {
      sessionId: session.sessionId ?? "sid",
      updatedAt: session.updatedAt ?? Date.now(),
      ...session,
    },
  });
}

export async function seedHeartbeatSessionRows(
  agentId: string,
  entries: Record<string, Partial<SessionEntry>>,
): Promise<void> {
  for (const [sessionKey, entry] of Object.entries(entries)) {
    upsertSessionEntry({
      agentId,
      sessionKey,
      entry: {
        sessionId: entry.sessionId ?? sessionKey.replace(/:/g, "_"),
        updatedAt: entry.updatedAt ?? Date.now(),
        ...entry,
      },
    });
  }
}

export function readHeartbeatSessionRows(agentId: string): Record<string, SessionEntry> {
  return Object.fromEntries(
    listSessionEntries({ agentId }).map((row) => [row.sessionKey, row.entry]),
  );
}

export async function seedMainHeartbeatSession(
  agentId: string,
  cfg: OpenClawConfig,
  session: HeartbeatSessionSeed,
): Promise<string> {
  const sessionKey = resolveMainSessionKey(cfg);
  await seedHeartbeatSession(agentId, sessionKey, session);
  return sessionKey;
}

export async function withTempHeartbeatSandbox<T>(
  fn: (ctx: { tmpDir: string; agentId: string; replySpy: HeartbeatReplySpy }) => Promise<T>,
  options?: {
    prefix?: string;
    unsetEnvVars?: string[];
  },
): Promise<T> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), options?.prefix ?? "openclaw-hb-"));
  await fs.writeFile(path.join(tmpDir, "HEARTBEAT.md"), "- Check status\n", "utf-8");
  const agentId = "main";
  const replySpy = createHeartbeatReplySpy();
  const previousEnv = new Map<string, string | undefined>();
  for (const envName of ["OPENCLAW_STATE_DIR", ...(options?.unsetEnvVars ?? [])]) {
    previousEnv.set(envName, process.env[envName]);
    process.env[envName] = envName === "OPENCLAW_STATE_DIR" ? tmpDir : "";
  }
  try {
    return await fn({ tmpDir, agentId, replySpy });
  } finally {
    replySpy.mockReset();
    for (const [envName, previousValue] of previousEnv.entries()) {
      if (previousValue === undefined) {
        delete process.env[envName];
      } else {
        process.env[envName] = previousValue;
      }
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

export async function withTempTelegramHeartbeatSandbox<T>(
  fn: (ctx: { tmpDir: string; agentId: string; replySpy: HeartbeatReplySpy }) => Promise<T>,
  options?: {
    prefix?: string;
  },
): Promise<T> {
  return withTempHeartbeatSandbox(fn, {
    prefix: options?.prefix,
    unsetEnvVars: ["TELEGRAM_BOT_TOKEN"],
  });
}

export function setupTelegramHeartbeatPluginRuntimeForTests() {
  setActivePluginRegistry(
    createTestRegistry([
      { pluginId: "telegram", plugin: heartbeatRunnerTelegramPlugin, source: "test" },
    ]),
  );
}
