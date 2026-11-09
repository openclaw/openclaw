/** Registers builtin policy and real-process predicate cases in the shared node fixture. */
import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as approvalsStore from "../infra/exec-approvals-store.test-support.js";
import type { ExecAsk, SystemRunApprovalPlan, loadExecApprovals } from "../infra/exec-approvals.js";
import type { buildSystemRunApprovalPlan } from "./invoke-system-run-plan.js";
import type { handleSystemRunInvoke } from "./invoke-system-run.js";
import {
  expectApprovalRequired,
  expectOk,
  invokeResult,
  type InvokeSpies,
} from "./invoke-system-run.test-support.js";
import type { RunResult } from "./invoke-types.js";

type InvokeOptions = Parameters<typeof handleSystemRunInvoke>[0];
type PreparedPlan = ReturnType<typeof buildSystemRunApprovalPlan>;
type SuccessfulPlan = Extract<PreparedPlan, { ok: true }>;
type PredicateFixture = {
  fixtureDir: (prefix: string) => string;
  runLocal: (params: {
    command?: string[];
    cwd?: string;
    security?: "full" | "allowlist";
    ask?: ExecAsk;
    preparedPlan?: SystemRunApprovalPlan;
    approvalDecision?: "allow-once";
    runCommand?: InvokeOptions["runCommand"];
    commitExecAuthorization?: InvokeOptions["commitExecAuthorization"];
  }) => Promise<InvokeSpies>;
  allowlistPolicy: () => Parameters<typeof approvalsStore.saveExecApprovals>[0];
  prepareCwdSession: (command: string[], cwd: string, sessionKey: string) => PreparedPlan;
  requireApprovalPlan: (
    prepared: PreparedPlan,
    message: string,
  ) => asserts prepared is SuccessfulPlan;
  durableFixture: (options: { payload: string }) => { tempDir: string; prepared: SuccessfulPlan };
  mutatePolicyOnCommit: (
    mutate: (current: ReturnType<typeof loadExecApprovals>) => void,
  ) => NonNullable<InvokeOptions["commitExecAuthorization"]>;
  localResult: (stdout: string) => RunResult;
};

// Registration stays inside the database-worker owner's describe: its policy reset,
// isolated OPENCLAW_HOME, real approval dispatch and teardown remain the sole fixture.
export function registerSystemRunPredicateTests(fixture: PredicateFixture): void {
  const {
    fixtureDir,
    runLocal,
    allowlistPolicy,
    prepareCwdSession,
    durableFixture,
    mutatePolicyOnCommit,
    localResult,
  } = fixture;
  const requireApprovalPlan: PredicateFixture["requireApprovalPlan"] = fixture.requireApprovalPlan;

  it
    .runIf(process.platform !== "win32")
    .each(["test -e 'proof.txt'", String.raw`$'te\x73t' -e $'proof.txt'`])(
    "R0124 executes literal node predicate without approval: %s",
    async (payload) => {
      const { runCommand } = await import("./invoke-run-command.js");
      const cwd = fixtureDir("openclaw-node-literal-predicate-");
      fs.writeFileSync(path.join(cwd, "proof.txt"), "predicate fixture\n");
      approvalsStore.saveExecApprovals(allowlistPolicy());

      const invoke = await runLocal({
        command: ["/bin/bash", "-c", payload],
        cwd,
        security: "allowlist",
        ask: "on-miss",
        runCommand,
      });

      expect(invoke.runCommand).toHaveBeenCalledOnce();
      expectOk(invoke.sendInvokeResult);
      expect(JSON.parse(invokeResult(invoke.sendInvokeResult).payloadJSON ?? "null")).toMatchObject(
        {
          success: true,
          exitCode: 0,
          timedOut: false,
          stdout: "",
          stderr: "",
          error: null,
        },
      );
    },
  );

  it.runIf(process.platform !== "win32").each(["test -e *.txt", String.raw`[ -e $'proof'* ]`])(
    "R0124 executes dynamic node predicate only after prepared allow-once: %s",
    async (payload) => {
      const { runCommand } = await import("./invoke-run-command.js");
      const cwd = fixtureDir("openclaw-node-dynamic-predicate-");
      // A single match makes the approved predicate genuinely succeed in Bash.
      fs.writeFileSync(path.join(cwd, "proof.txt"), "predicate fixture\n");
      approvalsStore.saveExecApprovals(allowlistPolicy());
      const command = ["/bin/bash", "-c", payload];

      const denied = await runLocal({
        command,
        cwd,
        security: "allowlist",
        ask: "on-miss",
        runCommand,
      });
      expectApprovalRequired(denied.sendNodeEvent, denied.sendInvokeResult);
      expect(denied.runCommand).not.toHaveBeenCalled();
      expect(denied.sendNodeEvent.mock.calls.some(([event]) => event === "exec.finished")).toBe(
        false,
      );

      // Reuse the node plan owner and the fixture's current-policy snapshot binding.
      // No fabricated plan or bypass of the real authorization commit/spawn callback.
      const prepared = prepareCwdSession(command, cwd, "agent:main:main");
      requireApprovalPlan(prepared, "expected a supported predicate approval plan");
      const approved = await runLocal({
        preparedPlan: prepared.plan,
        security: "allowlist",
        ask: "on-miss",
        approvalDecision: "allow-once",
        runCommand,
      });
      expect(approved.runCommand).toHaveBeenCalledOnce();
      expectOk(approved.sendInvokeResult);
      expect(
        JSON.parse(invokeResult(approved.sendInvokeResult).payloadJSON ?? "null"),
      ).toMatchObject({
        success: true,
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        error: null,
      });
    },
  );

  it("does not bind safe builtin policy to a redundant exact-command grant", async () => {
    if (process.platform === "win32") {
      return;
    }

    const { tempDir, prepared } = durableFixture({ payload: "cd ." });
    const commitAuthorization = mutatePolicyOnCommit((current) => {
      current.agents = { ...current.agents, main: { allowlist: [] } };
    });
    const rerun = await runLocal({
      security: "allowlist",
      ask: "on-miss",
      preparedPlan: prepared.plan,
      cwd: prepared.plan.cwd ?? tempDir,
      commitExecAuthorization: commitAuthorization,
      runCommand: vi.fn(async () => localResult("safe-builtin-ok")),
    });

    expect(commitAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({
          source: "current-policy",
          requireExactCommandApproval: false,
          requireDurableAllowlistApproval: false,
        }),
      }),
    );
    expect(rerun.runCommand).toHaveBeenCalledTimes(1);
    expectOk(rerun.sendInvokeResult, "safe-builtin-ok");
  });
}
