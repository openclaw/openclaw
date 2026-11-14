import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { drainSessionDiskBudgetWorkers } from "../config/sessions/disk-budget-runtime.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import type { sessionsCommand } from "./sessions.js";
import { createCapturingTestRuntime } from "./test-runtime-config-helpers.js";

const sessionsConfigState = vi.hoisted<{ loadConfig: () => Record<string, unknown> }>(() => ({
  loadConfig: () => ({
    agents: {
      defaults: {
        model: { primary: "test:opus" },
        models: { "test:opus": {} },
        contextTokens: 32000,
      },
    },
  }),
}));

const defaultSessionsConfigLoader = sessionsConfigState.loadConfig;

// mock-isolation: Session CLI fixtures select their own stores instead of the host session config.
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => sessionsConfigState.loadConfig(),
  loadConfig: () => sessionsConfigState.loadConfig(),
  captureRuntimeConfigAsyncReader: () => async () => sessionsConfigState.loadConfig(),
}));

export function setMockSessionsConfig(loader: () => Record<string, unknown>) {
  sessionsConfigState.loadConfig = loader;
}

export function resetMockSessionsConfig() {
  sessionsConfigState.loadConfig = defaultSessionsConfigLoader;
}

export function makeRuntime() {
  const captured = createCapturingTestRuntime();
  captured.runtime.exit = (code) => {
    throw new Error(`exit ${code}`);
  };
  return captured;
}

export async function writeStore(
  data: Record<string, SessionEntry>,
  prefix = "sessions",
  options: { agentId?: string } = {},
): Promise<string> {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const storePath = path.join(storeDir, "sessions.json");
  const agentId = options.agentId ?? "main";
  const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, { agentId }).path;
  openOpenClawAgentDatabase({ agentId, path: databasePath });
  for (const [sessionKey, entry] of Object.entries(data)) {
    await replaceSessionEntry({ agentId, sessionKey, storePath }, entry);
  }
  // Disk-budget scans inspect suffixed database owners; join them before handing off the fixture.
  await drainSessionDiskBudgetWorkers();
  await closeOpenClawAgentDatabaseByPathAsync(databasePath);
  return databasePath;
}

export function cleanupStore(store: string): void {
  fs.rmSync(path.dirname(store), { recursive: true, force: true });
}

export async function runSessionsJson<T>(
  run: typeof sessionsCommand,
  store: string,
  options?: Pick<Parameters<typeof sessionsCommand>[0], "active" | "limit">,
): Promise<T> {
  const { runtime, logs } = makeRuntime();
  try {
    await run({ store, json: true, active: options?.active, limit: options?.limit }, runtime);
  } finally {
    await closeOpenClawAgentDatabaseByPathAsync(
      resolveSqliteTargetFromSessionStorePath(store).path,
    );
    cleanupStore(store);
  }
  return JSON.parse(logs[0] ?? "{}") as T;
}
