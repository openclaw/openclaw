import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import {
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  makeCronSessionEntry,
  mockRunCronFallbackPassthrough,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronSessionMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const { prepareCronRunContext } = await import("./run-prepare.js");
const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function makeRolesCfg() {
  return {
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
  };
}

const inState = (run: () => Promise<void>) =>
  withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, run);

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
  it("completes run preparation for a channel-created job with the default-role sandbox stamped", async () => {
    resetRunCronIsolatedAgentTurnHarness();
    await inState(async () => {
      const storePath = path.join(
        tempDirs.make("openclaw-cron-channel-creator-store-"),
        "openclaw-agent.sqlite",
      );
      const jobId = "channel-reminder";
      const sessionId = "channel-creator-run";
      resolveCronSessionMock.mockReturnValue(
        makeCronSession({
          storePath,
          sessionEntry: makeCronSessionEntry({ sessionId }),
        }),
      );

      // Without a runPrepared callback, prepareCronRunContext returns only after the
      // whole preparation pipeline completes: a channel-native creator id passes the
      // creator-sandbox boundary, the cron session is prepared and persisted, and the
      // run is handed to execution instead of dying in cron setup.
      const preparation = await prepareCronRunContext({
        input: makeIsolatedAgentParamsFixture({
          agentId: "main",
          sessionKey: `cron:${jobId}`,
          cfg: makeRolesCfg(),
          job: makeIsolatedAgentJobFixture({
            id: jobId,
            sessionTarget: "isolated",
            delivery: { mode: "none" },
            createdActor: { type: "human", source: "channel", id: "U-CHANNEL-SENDER" },
          }),
        }),
        isFastTestEnv: true,
        onLifecycleInterrupt: () => {},
      });

      expect(preparation.ok).toBe(true);
      if (!preparation.ok) {
        return;
      }

      // The default role's sandbox requirement is stamped onto the persisted run session
      // before execution begins.
      const accessor = await vi.importActual<
        typeof import("../../config/sessions/session-accessor.js")
      >("../../config/sessions/session-accessor.js");
      const persisted = accessor.loadSessionEntry({
        agentId: "main",
        sessionKey: preparation.context.runSessionKey,
        storePath: preparation.context.cronSession.storePath,
      });
      expect(persisted?.sandbox).toBe("required");
    });
  });

  it("rejects a job whose verified profile creator no longer exists before model execution", async () => {
    resetRunCronIsolatedAgentTurnHarness();
    mockRunCronFallbackPassthrough();
    await inState(async () => {
      // A removed profile creator must fail closed: resuming under the default role could
      // drop the profile's required sandbox, so the run stops before any tool I/O.
      await expect(
        runCronIsolatedAgentTurn(
          makeIsolatedAgentParamsFixture({
            agentId: "main",
            sessionKey: "cron:stale-profile-job",
            cfg: makeRolesCfg(),
            job: makeIsolatedAgentJobFixture({
              id: "stale-profile-job",
              sessionTarget: "isolated",
              delivery: { mode: "none" },
              createdActor: { type: "human", source: "profile", id: "U-REMOVED-PROFILE" },
            }),
          }),
        ),
      ).rejects.toThrow(/user profile not found/i);
      expect(runWithModelFallbackMock).not.toHaveBeenCalled();
      expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    });
  });
});
