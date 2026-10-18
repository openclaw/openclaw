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
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
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
const acknowledgedConfig = {
  wizard: { securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT },
};

function onboarding(state: OpenClawTestState) {
  const database = { env: state.env };
  const begin = (
    overrides: Partial<Parameters<typeof beginLocalOnboarding>[0]> & { runId: string },
  ) =>
    beginLocalOnboarding({
      configPath: state.configPath,
      workspace: state.workspaceDir,
      securityAcknowledgedAt: SECURITY_ACKNOWLEDGED_AT,
      ...overrides,
      database,
    });
  const complete = (runId: string, nowMs?: number) =>
    completeLocalOnboarding({ configPath: state.configPath, runId, nowMs, database });
  const read = () => readLocalOnboardingState(state.configPath, database);
  const recover = (owner: Parameters<typeof completeLocalSetupRecovery>[0]["owner"]) =>
    completeLocalSetupRecovery({ owner, appliedConfigPath: state.configPath });
  const writeConfig = () =>
    state.writeConfig({
      agents: { defaults: { workspace: state.workspaceDir }, entries: { main: {} } },
      ...acknowledgedConfig,
    });
  return { database, begin, complete, read, recover, writeConfig };
}

void describe("local onboarding state", () => {
  void it("does not create persistent state when checking an unconfigured install", async () => {
    await withOpenClawTestState({ label: "local-onboarding-empty" }, async (state) => {
      const { read, complete } = onboarding(state);
      assert.equal(read(), undefined);
      assert.equal(await complete("missing-run"), false);
      assert.equal(fs.existsSync(state.statePath("state", "openclaw.sqlite")), false);
    });
  });

  void it("isolates receipts by configuration path", async () => {
    await withOpenClawTestState({ label: "local-onboarding-paths" }, async (state) => {
      const { database, begin, read } = onboarding(state);
      const first = begin({ runId: "first-run", nowMs: 100 });

      assert.deepEqual(read(), first);
      assert.equal(readLocalOnboardingState(state.path("other.json"), database), undefined);
      assert.partialDeepStrictEqual(first, {
        status: "pending",
        runId: "first-run",
        startedAtMs: 100,
      });
    });
  });

  void it("preserves the pending owner across repeated activation commits", async () => {
    await withOpenClawTestState({ label: "local-onboarding-owner" }, async (state) => {
      const { database, begin, complete, read } = onboarding(state);
      const first = begin({ runId: "first-run", teamCoordinatorId: " Project Lead " });
      closeOpenClawStateDatabaseForTest();
      assert.partialDeepStrictEqual(read(), { teamCoordinatorId: "project-lead" });
      const second = begin({
        workspace: state.path("other-workspace"),
        runId: "second-run",
        teamCoordinatorId: "different-coordinator",
      });

      assert.deepEqual(second, first);
      assert.equal(await complete("wrong"), false);
      assert.equal(read()?.status, "pending");
      assert.equal(await complete("first-run", 200), true);
      assert.partialDeepStrictEqual(
        await readLocalOnboardingStateForConfigAsync(
          state.configPath,
          acknowledgedConfig,
          database,
        ),
        { ...first, status: "completed", completedAtMs: 200 },
      );
    });
  });

  void it("rejects an unrepresentable team coordinator before creating a receipt", async () => {
    await withOpenClawTestState({ label: "local-onboarding-invalid-team" }, async (state) => {
      const { begin, read } = onboarding(state);
      assert.throws(
        () => begin({ runId: "invalid-team", teamCoordinatorId: "!!!" }),
        /coordinator/u,
      );
      assert.equal(read(), undefined);
    });
  });

  void it("prevents an interrupted pre-reset run from completing its replacement", async () => {
    await withOpenClawTestState({ label: "local-onboarding-reset" }, async (state) => {
      const { begin, complete, read } = onboarding(state);
      begin({ runId: "stale-run" });
      const replacement = begin({
        workspace: state.path("replacement-workspace"),
        securityAcknowledgedAt: "2026-08-03T00:00:00.000Z",
        runId: "new-run",
        replace: true,
        expectedRunId: "stale-run",
      });

      assert.equal(await complete("stale-run"), false);
      assert.deepEqual(read(), replacement);
      assert.equal(await complete("new-run"), true);
    });
  });

  void it("completes the same run idempotently without changing its original timestamp", async () => {
    await withOpenClawTestState({ label: "local-onboarding-idempotent" }, async (state) => {
      const { begin, complete, read } = onboarding(state);
      begin({ runId: "completed-run" });

      assert.equal(await complete("completed-run", 100), true);
      assert.equal(await complete("completed-run", 200), true);
      assert.equal(await complete("different-run", 300), false);
      assert.partialDeepStrictEqual(read(), {
        status: "completed",
        runId: "completed-run",
        completedAtMs: 100,
      });
    });
  });

  void it("completes its validated owner idempotently without rewriting the locked config", async () => {
    await withOpenClawTestState({ label: "local-onboarding-locked-completion" }, async (state) => {
      const { begin, read, recover, writeConfig } = onboarding(state);
      await writeConfig();
      const owner = begin({ runId: "locked-owner" });
      const originalConfig = fs.readFileSync(state.configPath, "utf8");

      const first = await recover(owner);
      const completed = read();
      const second = await recover(owner);

      assert.equal(first.path, state.configPath);
      assert.equal(second.path, state.configPath);
      assert.partialDeepStrictEqual(completed, { status: "completed", runId: owner.runId });
      assert.deepEqual(read(), completed);
      assert.equal(fs.readFileSync(state.configPath, "utf8"), originalConfig);
    });
  });

  void it("rejects a canonical config mutation that wins the completion lock", async () => {
    await withOpenClawTestState({ label: "local-onboarding-config-lock-race" }, async (state) => {
      const { begin, read, writeConfig } = onboarding(state);
      await writeConfig();
      const owner = begin({ runId: "racing-owner" });
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
            wizard: { ...lockedConfig.wizard, securityAcknowledgedAt: "2026-08-03T00:00:00.000Z" },
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

      assert.deepEqual(read(), owner);
      assert.equal(
        (await readConfigFileSnapshot()).sourceConfig.wizard?.securityAcknowledgedAt,
        "2026-08-03T00:00:00.000Z",
      );
    });
  });

  void it("rejects another receipt owner and an applied config at a different path", async () => {
    await withOpenClawTestState({ label: "local-onboarding-locked-ownership" }, async (state) => {
      const { begin, read, recover, writeConfig } = onboarding(state);
      await writeConfig();
      const owner = begin({ runId: "real-owner" });

      await assert.rejects(
        recover({ ...owner, runId: "different-owner" }),
        /Another onboarding run replaced this setup operation/u,
      );
      await assert.rejects(
        completeLocalSetupRecovery({ owner, appliedConfigPath: state.path("another-config.json") }),
        /onboarding configuration changed before setup could complete/u,
      );

      assert.deepEqual(read(), owner);
    });
  });

  void it("does not let a concurrent missing-config run replace the active owner", async () => {
    await withOpenClawTestState({ label: "local-onboarding-concurrent" }, async (state) => {
      const { begin, read } = onboarding(state);
      const active = begin({ runId: "active-run" });
      const concurrent = begin({
        workspace: state.path("concurrent-workspace"),
        securityAcknowledgedAt: "2026-08-03T00:00:00.000Z",
        runId: "concurrent-run",
        replace: true,
        expectedRunId: "stale-reset-run",
      });

      assert.deepEqual(concurrent, active);
      assert.deepEqual(read(), active);
    });
  });

  void it("does not let a delayed concurrent run reopen a completed owner", async () => {
    await withOpenClawTestState({ label: "local-onboarding-completed-owner" }, async (state) => {
      const { begin, complete, read } = onboarding(state);
      const first = begin({ runId: "completed-run" });
      assert.equal(await complete(first.runId), true);
      const completed = read();

      for (const replacement of [
        {},
        { replace: true },
        { replace: true, expectedRunId: "other-run" },
      ]) {
        const concurrent = begin({
          workspace: state.path("concurrent-workspace"),
          securityAcknowledgedAt: "2026-08-03T00:00:00.000Z",
          runId: "delayed-run",
          ...replacement,
        });
        assert.deepEqual(concurrent, completed);
        assert.deepEqual(read(), completed);
      }
    });
  });

  void it("replaces a completed owner only when reset observed its exact run", async () => {
    await withOpenClawTestState({ label: "local-onboarding-completed-reset" }, async (state) => {
      const { begin, complete, read } = onboarding(state);
      const first = begin({ runId: "observed-completed-run" });
      assert.equal(await complete(first.runId), true);

      const replacement = begin({
        workspace: state.path("replacement-workspace"),
        securityAcknowledgedAt: "2026-08-03T00:00:00.000Z",
        runId: "replacement-run",
        replace: true,
        expectedRunId: first.runId,
      });

      assert.partialDeepStrictEqual(replacement, { status: "pending", runId: "replacement-run" });
      assert.deepEqual(read(), replacement);
    });
  });

  void it("binds receipts to the acknowledged configuration identity", async () => {
    await withOpenClawTestState({ label: "local-onboarding-config-identity" }, async (state) => {
      const { database, begin, read } = onboarding(state);
      const pending = begin({ runId: "original-run" });

      assert.deepEqual(
        readLocalOnboardingStateForConfig(state.configPath, acknowledgedConfig, database),
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
      assert.deepEqual(read(), pending);
    });
  });
});
