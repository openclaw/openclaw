import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, it } from "node:test";
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
const replacementAcknowledgement = "2026-08-03T00:00:00.000Z";

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
    completeLocalOnboarding({ configPath: state.configPath, runId, nowMs });
  const read = () => readLocalOnboardingState(state.configPath, database);
  const recover = (owner: Parameters<typeof completeLocalSetupRecovery>[0]["owner"]) =>
    completeLocalSetupRecovery({ owner, appliedConfigPath: state.configPath });
  const writeConfig = () =>
    state.writeConfig({
      agents: { defaults: { workspace: state.workspaceDir }, entries: { main: {} } },
      ...acknowledgedConfig,
    });
  const replace = (runId: string, expectedRunId: string) =>
    begin({
      workspace: state.path("replacement-workspace"),
      securityAcknowledgedAt: replacementAcknowledgement,
      runId,
      replace: true,
      expectedRunId,
    });
  return { database, begin, complete, read, recover, writeConfig, replace };
}

function test(
  name: string,
  run: (context: ReturnType<typeof onboarding> & { state: OpenClawTestState }) => Promise<void>,
) {
  void it(name, () =>
    withOpenClawTestState({ label: "local-onboarding" }, (state) =>
      run({ ...onboarding(state), state }),
    ),
  );
}

test("does not create persistent state when checking an unconfigured install", async (context) => {
  const { read, complete, state } = context;
  assert.equal(read(), undefined);
  assert.equal(await complete("missing-run"), false);
  assert.equal(fs.existsSync(state.statePath("state", "openclaw.sqlite")), false);
});

test("isolates receipts by configuration path", async ({ database, begin, read, state }) => {
  const first = begin({ runId: "first-run", nowMs: 100 });

  assert.deepEqual(read(), first);
  assert.equal(readLocalOnboardingState(state.path("other.json"), database), undefined);
  assert.partialDeepStrictEqual(first, {
    status: "pending",
    runId: "first-run",
    startedAtMs: 100,
  });
});

test("preserves the pending owner across repeated activation commits", async (context) => {
  const { database, begin, complete, read, state } = context;
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
    await readLocalOnboardingStateForConfigAsync(state.configPath, acknowledgedConfig, database),
    { ...first, status: "completed", completedAtMs: 200 },
  );
});

test("rejects an unrepresentable team coordinator before creating a receipt", async (context) => {
  const { begin, read } = context;
  assert.throws(() => begin({ runId: "invalid-team", teamCoordinatorId: "!!!" }), /coordinator/u);
  assert.equal(read(), undefined);
});

for (const status of ["pending", "completed"] as const) {
  test(`resets the observed ${status} owner and rejects stale completion`, async (context) => {
    const { begin, complete, read, replace } = context;
    const first = begin({ runId: "original-run" });
    if (status === "completed") {
      assert.equal(await complete(first.runId), true);
    }
    const replacement = replace("replacement-run", first.runId);
    assert.partialDeepStrictEqual(replacement, { status: "pending", runId: "replacement-run" });
    assert.equal(await complete(first.runId), false);
    assert.deepEqual(read(), replacement);
    assert.equal(await complete(replacement.runId), true);
  });
}

test("completes the same run idempotently without changing its original timestamp", async (context) => {
  const { begin, complete, read } = context;
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

test("completes its validated owner idempotently without rewriting the locked config", async (context) => {
  const { begin, read, recover, writeConfig, state } = context;
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

test("rejects a canonical config mutation that wins the completion lock", async (context) => {
  const { begin, read, writeConfig } = context;
  await writeConfig();
  const owner = begin({ runId: "racing-owner" });
  const optimisticSnapshot = await readConfigFileSnapshot();
  assert.equal(
    optimisticSnapshot.sourceConfig.wizard?.securityAcknowledgedAt,
    SECURITY_ACKNOWLEDGED_AT,
  );
  const lockHeld = Promise.withResolvers<void>();
  const mutationReleased = Promise.withResolvers<void>();
  const competingMutation = withConfigMutationExclusive(async (lockedConfig) => {
    lockHeld.resolve();
    await mutationReleased.promise;
    await replaceConfigFile({
      nextConfig: {
        ...lockedConfig,
        wizard: { ...lockedConfig.wizard, securityAcknowledgedAt: replacementAcknowledgement },
      },
    });
  });
  await lockHeld.promise;
  const completionFails = assert.rejects(
    completeLocalSetupRecovery({ owner, appliedConfigPath: optimisticSnapshot.path }),
    /onboarding configuration changed before setup could complete/u,
  );

  mutationReleased.resolve();
  await competingMutation;
  await completionFails;

  assert.deepEqual(read(), owner);
  assert.equal(
    (await readConfigFileSnapshot()).sourceConfig.wizard?.securityAcknowledgedAt,
    replacementAcknowledgement,
  );
});

test("rejects another receipt owner and an applied config at a different path", async (context) => {
  const { begin, read, recover, writeConfig, state } = context;
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

test("does not let a concurrent missing-config run replace the active owner", async (context) => {
  const { begin, read, replace } = context;
  const active = begin({ runId: "active-run" });
  const concurrent = replace("concurrent-run", "stale-reset-run");

  assert.deepEqual(concurrent, active);
  assert.deepEqual(read(), active);
});

test("does not let a delayed concurrent run reopen a completed owner", async (context) => {
  const { begin, complete, read, state } = context;
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
      securityAcknowledgedAt: replacementAcknowledgement,
      runId: "delayed-run",
      ...replacement,
    });
    assert.deepEqual(concurrent, completed);
    assert.deepEqual(read(), completed);
  }
});

test("binds receipts to the acknowledged configuration identity", async (context) => {
  const { database, begin, read, state } = context;
  const pending = begin({ runId: "original-run" });

  assert.deepEqual(
    readLocalOnboardingStateForConfig(state.configPath, acknowledgedConfig, database),
    pending,
  );
  assert.equal(
    readLocalOnboardingStateForConfig(
      state.configPath,
      { wizard: { securityAcknowledgedAt: replacementAcknowledgement } },
      database,
    ),
    undefined,
  );
  assert.equal(readLocalOnboardingStateForConfig(state.configPath, {}, database), undefined);
  assert.deepEqual(read(), pending);
});
