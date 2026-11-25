import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
} from "../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { recordMessageToolRunOutcome } from "./message-tool-run-outcome-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

let env: NodeJS.ProcessEnv;
let target: { agentId: string; env: NodeJS.ProcessEnv };
beforeEach(() => {
  env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-message-tool-outcome-") };
  target = { agentId: "main", env };
});

type Outcome = Parameters<typeof recordMessageToolRunOutcome>[0];

const outcomeInput = (runId: string, overrides: Partial<Outcome> = {}) => ({
  ...target,
  sessionKey: "agent:main:main",
  provider: "openai",
  model: "gpt-5.6-luna",
  outcome: "mute" as const,
  runStatus: "completed" as const,
  occurredAt: 100,
  ...overrides,
  runId,
});

const recordOutcome = (runId: string, overrides?: Parameters<typeof outcomeInput>[1]) =>
  recordMessageToolRunOutcome(outcomeInput(runId, overrides));

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});

describe("message-tool run outcome store", () => {
  it("does not recreate an absent incognito session for late outcome metadata", async () => {
    await expect(
      recordOutcome("private", {
        sessionKey: "agent:main:dashboard:incognito-outcome",
        runStatus: "aborted",
      }),
    ).rejects.toThrow("incognito");
    const privateTarget = { ...target, path: resolveIncognitoOpenClawAgentSqlitePath(target) };
    expect(memorySessionActorOwners.read(privateTarget)).toBeUndefined();
    expect(getOpenClawAgentDatabaseIfOpen(privateTarget)).toBeUndefined();
    expect(getOpenClawAgentDatabaseIfOpen(target)).toBeUndefined();
  });
});
