import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, describe, it } from "node:test";
import { isMainThread } from "node:worker_threads";
import {
  readConfigFileSnapshot,
  replaceConfigFile,
  withConfigMutationExclusive,
} from "../config/config.js";
import { completeLocalSetupRecovery } from "../system-agent/setup-recovery.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  beginLocalOnboarding,
  completeLocalOnboarding,
  readLocalOnboardingState,
  readLocalOnboardingStateForConfig,
  readLocalOnboardingStateForConfigAsync,
} from "./local-onboarding-state.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

assert.equal(isMainThread, true, "Onboarding completion requires the host writer broker");
afterEach(() => closeOpenClawStateDatabaseForTest());

const SECURITY_ACKNOWLEDGED_AT = "2026-08-02T00:00:00.000Z";

describe("local onboarding state", () => {
  it("does not create persistent state when checking an unconfigured install", async () => {
    await withOpenClawTestState({ label: "local-onboarding-empty" }, async (state) => {
      assert.equal(readLocalOnboardingState(state.configPath, { env: state.env }), undefined);
      assert.equal(
        await completeLocalOnboarding({
          configPath: state.configPath,
          runId: "missing-run",
          database: { env: state.env },
        }),
        false,
      );
      assert.equal(fs.existsSync(state.statePath("state", "openclaw.sqlite")), false);
    });
  });

  it("isolates receipts by configuration path", async () => {
    await withOpenClawTestState({ label: "local-onboarding-paths" }, async (state) => {
      const database = { env: state.env };
      const first = beginLocalOnboarding({
        configPath: state.configPath,
        workspace: state.workspaceDir,
        securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT,
        runId: "first-run",
        nowMs: 100,
        database,
      });

      assert.deepEqual(readLocalOnboardingState(state.configPath, database), first);
      assert.equal(readLocalOnboardingState(state.path("other.json"), database), undefined);
      assert.partialDeepStrictEqual(first, {
        status: "pending",
        runId: "first-run",
        startedAtMs: 100,
      });
    });
  });

  it("preserves the pending owner across repeated activation commits", async () => {
    await withOpenClawTestState({ label: "local-onboarding-owner" }, async (state) => {
      const database = { env: state.env };
      const first = beginLocalOnboarding({
        configPath: state.configPath,
        workspace: state.workspaceDir,
        securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT,
        runId: "first-run",
        teamCoordinatorId: " Project Lead ",
        database,
      });
      closeOpenClawStateDatabaseForTest();
      assert.partialDeepStrictEqual(readLocalOnboardingState(state.configPath, database), {
        teamCoordinatorId: "project-lead",
      });
      const second = beginLocalOnboarding({
        configPath: state.configPath,
        workspace: state.path("other-workspace"),
        securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT,
        runId: "second-run",
        teamCoordinatorId: "different-coordinator",
        database,
      });

      assert.deepEqual(second, first);
      assert.equal(
        await completeLocalOnboarding({ configPath: state.configPath, runId: "wrong", database }),
        false,
      );
      assert.equal(readLocalOnboardingState(state.configPath, database)?.status, "pending");
      assert.equal(
        await completeLocalOnboarding({
          configPath: state.configPath,
          runId: "first-run",
          nowMs: 200,
          database,
        }),
        true,
      );
      assert.partialDeepStrictEqual(
        await readLocalOnboardingStateForConfigAsync(
          state.configPath,
          { wizard: { securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT } },
          database,
        ),
        {
          ...first,
          status: "completed",
          completedAtMs: 200,
        },
      );
    });
  });

  it("rejects an unrepresentable team coordinator before creating a receipt", async () => {
    await withOpenClawTestState({ label: "local-onboarding-invalid-team" }, async (state) => {
      const database = { env: state.env };
      assert.throws(
        () =>
          beginLocalOnboarding({
            configPath: state.configPath,
            workspace: state.workspaceDir,
            securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT,
            runId: "invalid-team",
            teamCoordinatorId: "!!!",
            database,
          }),
        /coordinator/u,
      );
      assert.equal(readLocalOnboardingState(state.configPath, database), undefined);
    });
  });

  it("prevents an interrupted pre-reset run from completing its replacement", async () => {
    await withOpenClawTestState({ label: "local-onboarding-reset" }, async (state) => {
      const database = { env: state.env };
      beginLocalOnboarding({
        configPath: state.configPath,
        workspace: state.workspaceDir,
        securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT,
        runId: "stale-run",
        database,
      });
      const replacement = beginLocalOnboarding({
        configPath: state.configPath,
        workspace: state.path("replacement-workspace"),
        securityAcknowledgedAt: "2026-08-03T00:00:00.000Z",
        runId: "new-run",
        replace: true,
        expectedRunId: "stale-run",
        database,
      });

      assert.equal(
        await completeLocalOnboarding({
          configPath: state.configPath,
          runId: "stale-run",
          database,
        }),
        false,
      );
      assert.deepEqual(readLocalOnboardingState(state.configPath, database), replacement);
      assert.equal(
        await completeLocalOnboarding({ configPath: state.configPath, runId: "new-run", database }),
        true,
      );
    });
  });

  it("completes the same run idempotently without changing its original timestamp", async () => {
    await withOpenClawTestState({ label: "local-onboarding-idempotent" }, async (state) => {
      const database = { env: state.env };
      beginLocalOnboarding({
        configPath: state.configPath,
        workspace: state.workspaceDir,
        securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT,
        runId: "completed-run",
        database,
      });

      assert.equal(
        await completeLocalOnboarding({
          configPath: state.configPath,
          runId: "completed-run",
          nowMs: 100,
          database,
        }),
        true,
      );
      assert.equal(
        await completeLocalOnboarding({
          configPath: state.configPath,
          runId: "completed-run",
          nowMs: 200,
          database,
        }),
        true,
      );
      assert.equal(
        await completeLocalOnboarding({
          configPath: state.configPath,
          runId: "different-run",
          nowMs: 300,
          database,
        }),
        false,
      );
      assert.partialDeepStrictEqual(readLocalOnboardingState(state.configPath, database), {
        status: "completed",
        runId: "completed-run",
        completedAtMs: 100,
      });
    });
  });

  it("completes its validated owner idempotently without rewriting the locked config", async () => {
    await withOpenClawTestState({ label: "local-onboarding-locked-completion" }, async (state) => {
      const database = { env: state.env };
      await state.writeConfig({
        agents: {
          defaults: { workspace: state.workspaceDir },
          entries: { main: {} },
        },
        wizard: { securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT },
      });
      const owner = beginLocalOnboarding({
        configPath: state.configPath,
        workspace: state.workspaceDir,
        securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT,
        runId: "locked-owner",
        database,
      });
      const originalConfig = fs.readFileSync(state.configPath, "utf8");

      const first = await completeLocalSetupRecovery({
        owner,
        appliedConfigPath: state.configPath,
      });
      const completed = readLocalOnboardingState(state.configPath, database);
      const second = await completeLocalSetupRecovery({
        owner,
        appliedConfigPath: state.configPath,
      });

      assert.equal(first.path, state.configPath);
      assert.equal(second.path, state.configPath);
      assert.partialDeepStrictEqual(completed, { status: "completed", runId: owner.runId });
      assert.deepEqual(readLocalOnboardingState(state.configPath, database), completed);
      assert.equal(fs.readFileSync(state.configPath, "utf8"), originalConfig);
    });
  });

  it("rejects a canonical config mutation that wins the completion lock", async () => {
    await withOpenClawTestState({ label: "local-onboarding-config-lock-race" }, async (state) => {
      const database = { env: state.env };
      await state.writeConfig({
        agents: {
          defaults: { workspace: state.workspaceDir },
          entries: { main: {} },
        },
        wizard: { securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT },
      });
      const owner = beginLocalOnboarding({
        configPath: state.configPath,
        workspace: state.workspaceDir,
        securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT,
        runId: "racing-owner",
        database,
      });
      const optimisticSnapshot = await readConfigFileSnapshot();
      assert.equal(
        optimisticSnapshot.sourceConfig.wizard?.securityAcknowledgedAt,
        SECURITY_ACKNOWLEDGED_AT,
      );
      let notifyLockHeld!: () => void;
      let releaseMutation!: () => void;
      const lockHeld = new Promise<void>((resolve) => {
        notifyLockHeld = resolve;
      });
      const mutationReleased = new Promise<void>((resolve) => {
        releaseMutation = resolve;
      });
      const competingMutation = withConfigMutationExclusive(async (lockedConfig) => {
        notifyLockHeld();
        await mutationReleased;
        await replaceConfigFile({
          nextConfig: {
            ...lockedConfig,
            wizard: {
              ...lockedConfig.wizard,
              securityAcknowledgedAt: "2026-08-03T00:00:00.000Z",
            },
          },
        });
      });
      await lockHeld;
      const completionFails = assert.rejects(
        completeLocalSetupRecovery({ owner, appliedConfigPath: optimisticSnapshot.path }),
        /onboarding configuration changed before setup could complete/u,
      );

      releaseMutation();
      await competingMutation;
      await completionFails;

      assert.deepEqual(readLocalOnboardingState(state.configPath, database), owner);
      assert.equal(
        (await readConfigFileSnapshot()).sourceConfig.wizard?.securityAcknowledgedAt,
        "2026-08-03T00:00:00.000Z",
      );
    });
  });

  it("rejects another receipt owner and an applied config at a different path", async () => {
    await withOpenClawTestState({ label: "local-onboarding-locked-ownership" }, async (state) => {
      const database = { env: state.env };
      await state.writeConfig({
        agents: {
          defaults: { workspace: state.workspaceDir },
          entries: { main: {} },
        },
        wizard: { securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT },
      });
      const owner = beginLocalOnboarding({
        configPath: state.configPath,
        workspace: state.workspaceDir,
        securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT,
        runId: "real-owner",
        database,
      });

      await assert.rejects(
        completeLocalSetupRecovery({
          owner: { ...owner, runId: "different-owner" },
          appliedConfigPath: state.configPath,
        }),
        /Another onboarding run replaced this setup operation/u,
      );
      await assert.rejects(
        completeLocalSetupRecovery({
          owner,
          appliedConfigPath: state.path("another-config.json"),
        }),
        /onboarding configuration changed before setup could complete/u,
      );

      assert.deepEqual(readLocalOnboardingState(state.configPath, database), owner);
    });
  });

  it("does not let a concurrent missing-config run replace the active owner", async () => {
    await withOpenClawTestState({ label: "local-onboarding-concurrent" }, async (state) => {
      const database = { env: state.env };
      const active = beginLocalOnboarding({
        configPath: state.configPath,
        workspace: state.workspaceDir,
        securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT,
        runId: "active-run",
        database,
      });
      const concurrent = beginLocalOnboarding({
        configPath: state.configPath,
        workspace: state.path("concurrent-workspace"),
        securityAcknowledgedAt: "2026-08-03T00:00:00.000Z",
        runId: "concurrent-run",
        replace: true,
        expectedRunId: "stale-reset-run",
        database,
      });

      assert.deepEqual(concurrent, active);
      assert.deepEqual(readLocalOnboardingState(state.configPath, database), active);
    });
  });

  it("does not let a delayed concurrent run reopen a completed owner", async () => {
    await withOpenClawTestState({ label: "local-onboarding-completed-owner" }, async (state) => {
      const database = { env: state.env };
      const first = beginLocalOnboarding({
        configPath: state.configPath,
        workspace: state.workspaceDir,
        securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT,
        runId: "completed-run",
        database,
      });
      assert.equal(
        await completeLocalOnboarding({
          configPath: state.configPath,
          runId: first.runId,
          database,
        }),
        true,
      );
      const completed = readLocalOnboardingState(state.configPath, database);

      for (const replacement of [
        {},
        { replace: true },
        { replace: true, expectedRunId: "other-run" },
      ]) {
        const concurrent = beginLocalOnboarding({
          configPath: state.configPath,
          workspace: state.path("concurrent-workspace"),
          securityAcknowledgedAt: "2026-08-03T00:00:00.000Z",
          runId: "delayed-run",
          ...replacement,
          database,
        });
        assert.deepEqual(concurrent, completed);
        assert.deepEqual(readLocalOnboardingState(state.configPath, database), completed);
      }
    });
  });

  it("replaces a completed owner only when reset observed its exact run", async () => {
    await withOpenClawTestState({ label: "local-onboarding-completed-reset" }, async (state) => {
      const database = { env: state.env };
      const first = beginLocalOnboarding({
        configPath: state.configPath,
        workspace: state.workspaceDir,
        securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT,
        runId: "observed-completed-run",
        database,
      });
      assert.equal(
        await completeLocalOnboarding({
          configPath: state.configPath,
          runId: first.runId,
          database,
        }),
        true,
      );

      const replacement = beginLocalOnboarding({
        configPath: state.configPath,
        workspace: state.path("replacement-workspace"),
        securityAcknowledgedAt: "2026-08-03T00:00:00.000Z",
        runId: "replacement-run",
        replace: true,
        expectedRunId: first.runId,
        database,
      });

      assert.partialDeepStrictEqual(replacement, { status: "pending", runId: "replacement-run" });
      assert.deepEqual(readLocalOnboardingState(state.configPath, database), replacement);
    });
  });

  it("binds receipts to the acknowledged configuration identity", async () => {
    await withOpenClawTestState({ label: "local-onboarding-config-identity" }, async (state) => {
      const database = { env: state.env };
      const pending = beginLocalOnboarding({
        configPath: state.configPath,
        workspace: state.workspaceDir,
        securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT,
        runId: "original-run",
        database,
      });

      assert.deepEqual(
        readLocalOnboardingStateForConfig(
          state.configPath,
          { wizard: { securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT } },
          database,
        ),
        pending,
      );
      assert.equal(
        readLocalOnboardingStateForConfig(
          state.configPath,
          { wizard: { securityAcknowledgedAt: "2026-08-03T00:00:00.000Z" } },
          database,
        ),
        undefined,
      );
      assert.equal(readLocalOnboardingStateForConfig(state.configPath, {}, database), undefined);
      assert.deepEqual(readLocalOnboardingState(state.configPath, database), pending);
    });
  });
});
