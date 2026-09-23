import { expect, it, vi } from "vitest";
import * as packageMetadata from "../../infra/update-check-package-target.js";
import * as writeAdmission from "../../infra/update-freebsd-write-admission.js";
import * as retainedRuntime from "../../infra/update-retained-runtime.js";
import { createUpdateRun, finishUpdateRun } from "../../infra/update-run-ledger.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import * as shared from "./shared.js";
import * as execution from "./update-command-execution.js";
import { installFreshUpdateFixture } from "./update-command-fresh.test-support.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import * as servicePlan from "./update-command-service-plan.js";
import { updateCommand } from "./update-command.js";

const { fixture } = installFreshUpdateFixture();

it.each(["current", "root revoked", "executor revoked"] as const)(
  "checks both mutation authorities during runtime retention: %s",
  async (state) => {
    const record = createUpdateRun({ trigger: "cli" });
    vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", record.runId);
    vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", "1");
    vi.mocked(shared.resolveTargetVersion).mockResolvedValue("2026.9.4");
    vi.mocked(packageMetadata.fetchNpmPackageTargetStatus).mockResolvedValue({
      target: "2026.9.4",
      version: "2026.9.4",
      nodeEngine: null,
      schemaVersions: {
        state: OPENCLAW_STATE_SCHEMA_VERSION,
        agent: OPENCLAW_AGENT_SCHEMA_VERSION,
      },
    });
    vi.spyOn(servicePlan, "resolvePackageRuntimePreflight").mockResolvedValue({
      ok: true,
      value: { nodeRunner: process.execPath },
    });
    const rootFailure = Object.assign(new Error("Fixture write authority revoked"), {
      reason: "freebsd-update-ownership",
    });
    const executorFailure = new UpdateCommandRecoveryPendingError("Executor revoked during copy");
    let rootRevoked = false;
    let revokeExecutor: () => void;
    let preparationFailure: unknown;
    let admittedEnv: NodeJS.ProcessEnv | undefined;
    const mutation = vi.fn();
    // Let canonical run admission bind this owner before retention records progress.
    vi.spyOn(writeAdmission, "createFreeBsdUpdateWriteAdmission").mockReturnValue({
      get canWrite() {
        return !rootRevoked;
      },
      get failure() {
        return rootRevoked ? rootFailure : undefined;
      },
      assertCurrent() {
        if (rootRevoked) {
          throw rootFailure;
        }
      },
      revoke(cause) {
        return cause instanceof Error ? cause : new Error(String(cause));
      },
      async revalidate(assertIdle) {
        assertIdle();
        this.assertCurrent();
      },
    });
    // Keep real command/executor admission and generation cleanup. The supplied
    // write latch proves callback composition, not native ownership.
    const withRuntime = retainedRuntime.withRetainedUpdateRuntime;
    const retain = vi.fn<retainedRuntime.RetainUpdateRuntime>(async ({ assertCurrent }) => {
      assertCurrent();
      await Promise.resolve();
      if (state === "root revoked") {
        rootRevoked = true;
      } else if (state === "executor revoked") {
        revokeExecutor();
      }
      assertCurrent();
    });
    vi.spyOn(retainedRuntime, "withRetainedUpdateRuntime").mockImplementation(
      (moduleUrl, operation) => withRuntime(moduleUrl, () => operation(retain)),
    );
    const execute = vi
      .spyOn(execution, "executeMutableUpdate")
      .mockImplementation(async (params) => {
        const run = params.opts.run!;
        admittedEnv = run.env;
        try {
          await params.prepareMutableUpdate(run.env, undefined, (fence) => {
            run.executorFence = fence;
            revokeExecutor = () => {
              vi.spyOn(fence, "assertCurrent").mockImplementation(() => {
                throw executorFailure;
              });
            };
          });
        } catch (error) {
          preparationFailure = error;
          throw error;
        }
        mutation();
        finishUpdateRun(record.runId, { status: "succeeded" }, { env: run.env });
        return null;
      });

    const operation = updateCommand({ tag: "2026.9.4", yes: true, json: true, restart: false });
    if (state === "current") {
      await operation;
      expect(preparationFailure).toBeUndefined();
      expect(mutation).toHaveBeenCalledOnce();
    } else {
      await expect(operation).rejects.toBeInstanceOf(Error);
      expect(preparationFailure).toBe(state === "root revoked" ? rootFailure : executorFailure);
      expect(mutation).not.toHaveBeenCalled();
    }
    expect(execute).toHaveBeenCalledOnce();
    expect(retain).toHaveBeenCalledExactlyOnceWith({
      mutationRoots: [fixture.root],
      installTarget: undefined,
      env: admittedEnv,
      timeoutMs: 5_000,
      assertCurrent: expect.any(Function),
    });
  },
);
