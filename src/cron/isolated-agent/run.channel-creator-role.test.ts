import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import {
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronSessionMock,
} from "./run.test-harness.js";

const { prepareCronRunContext } = await import("./run-prepare.js");
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    cleanup();
  }),
);

describe("cron channel-created jobs under gateway.roles", () => {
  it("prepares a run for a channel-created job instead of failing on the creator profile", async () => {
    resetRunCronIsolatedAgentTurnHarness();
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-cron-channel-creator-role-"));
    const scope = { agentId: "main", env: process.env };
    const database = openOpenClawAgentDatabase(scope);
    const sourceKey = "agent:main:source";
    const now = Date.now();
    runOpenClawAgentWriteTransaction((current) => {
      writeSessionEntry(current, sourceKey, {
        sessionId: "source-session",
        lifecycleRevision: "source-revision",
        updatedAt: now,
        sessionStartedAt: now,
        skillsSnapshot: { prompt: "source prompt", skills: [] },
      });
    }, scope);

    // resolveCreatorSandbox runs before session preparation, so reaching this
    // boundary proves a channel-native creator id no longer fails the run before
    // any session writes or tool execution. The stamped sandbox value itself is
    // covered by the operator-role-policy unit test.
    const preparedBoundary = new Error("cron session preparation complete");
    resolveCronSessionMock.mockImplementation(async () => {
      throw preparedBoundary;
    });

    await expect(
      prepareCronRunContext({
        input: makeIsolatedAgentParamsFixture({
          agentId: "main",
          cfg: {
            session: { store: database.path },
            gateway: {
              roles: {
                default: "guest",
                definitions: {
                  guest: {
                    sessions: { others: "view" },
                    agents: [],
                    scopes: [],
                    sandbox: "required",
                  },
                },
              },
            },
          },
          sessionKey: sourceKey,
          job: makeIsolatedAgentJobFixture({
            sessionTarget: "current",
            sessionKey: sourceKey,
            delivery: { mode: "none" },
            createdActor: { type: "human", source: "channel", id: "U-CHANNEL-SENDER" },
          }),
        }),
        isFastTestEnv: true,
        onLifecycleInterrupt: () => {},
      }),
    ).rejects.toBe(preparedBoundary);
  });
});
