import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { upsertSessionEntry } from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";

const sessionsConfigState = vi.hoisted<{ loadConfig: () => Record<string, unknown> }>(() => ({
  loadConfig: () => ({
    agents: {
      defaults: {
        model: { primary: "pi:opus" },
        models: { "pi:opus": {} },
        contextTokens: 32000,
      },
    },
  }),
}));

const defaultSessionsConfigLoader = sessionsConfigState.loadConfig;
const writtenStateRoots = new Set<string>();

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => sessionsConfigState.loadConfig(),
  loadConfig: () => sessionsConfigState.loadConfig(),
}));

export function mockSessionsConfig() {
  // The shared config mock is hoisted above so tests can keep their
  // existing setup call without paying `importActual` cost or nested-mock
  // warnings before importing `sessions.ts`.
}

export function setMockSessionsConfig(loader: () => Record<string, unknown>) {
  sessionsConfigState.loadConfig = loader;
}

export function resetMockSessionsConfig() {
  sessionsConfigState.loadConfig = defaultSessionsConfigLoader;
}

export function cleanupWrittenSessionState() {
  closeOpenClawAgentDatabasesForTest();
  for (const root of writtenStateRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  writtenStateRoots.clear();
  vi.unstubAllEnvs();
}

export function makeRuntime(params?: { throwOnError?: boolean }): {
  runtime: RuntimeEnv;
  logs: string[];
  errors: string[];
} {
  const logs: string[] = [];
  const errors: string[] = [];
  const throwOnError = params?.throwOnError ?? false;
  return {
    runtime: {
      log: (msg: unknown) => logs.push(String(msg)),
      error: (msg: unknown) => {
        errors.push(String(msg));
        if (throwOnError) {
          throw new Error(String(msg));
        }
      },
      exit: (code: number) => {
        throw new Error(`exit ${code}`);
      },
    },
    logs,
    errors,
  };
}

export function seedSessionRows(data: unknown, prefix = "sessions"): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-${Date.now()}-${randomUUID()}-`));
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  writtenStateRoots.add(root);
  const entries =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, SessionEntry>)
      : {};
  for (const [sessionKey, entry] of Object.entries(entries)) {
    upsertSessionEntry({ agentId: "main", sessionKey, entry });
  }
}

export async function runSessionsJson<T>(
  run: (
    opts: { json?: boolean; active?: string; limit?: string | number },
    runtime: RuntimeEnv,
  ) => Promise<void>,
  options?: {
    active?: string;
    limit?: string | number;
  },
): Promise<T> {
  const { runtime, logs } = makeRuntime();
  try {
    await run(
      {
        json: true,
        active: options?.active,
        limit: options?.limit,
      },
      runtime,
    );
  } finally {
    cleanupWrittenSessionState();
  }
  return JSON.parse(logs[0] ?? "{}") as T;
}
