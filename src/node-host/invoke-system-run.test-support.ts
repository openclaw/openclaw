import crypto from "node:crypto";
import { expect, type Mock } from "vitest";
import type * as approvalsStore from "../infra/exec-approvals-store.test-support.js";
import type { ExecAsk, ExecSecurity } from "../infra/exec-approvals.js";
import type { ExecHostResponse, requestExecHostViaSocket } from "../infra/exec-host.js";
import type { handleSystemRunInvoke } from "./invoke-system-run.js";

type InvokeOptions = Parameters<typeof handleSystemRunInvoke>[0];

export type MockedRunCommand = Mock<InvokeOptions["runCommand"]>;
type MockedRequestExecHost = Mock<typeof requestExecHostViaSocket>;
type MockedSendInvokeResult = Mock<InvokeOptions["sendInvokeResult"]>;
type MockedSendNodeEvent = Mock<NonNullable<InvokeOptions["sendNodeEvent"]>>;
export type InvokeSpies = {
  runCommand: MockedRunCommand;
  requestExecHost: MockedRequestExecHost;
  sendInvokeResult: MockedSendInvokeResult;
  sendNodeEvent: MockedSendNodeEvent;
};

export function localResult(stdout = "local-ok") {
  return {
    success: true,
    stdout,
    stderr: "",
    timedOut: false,
    truncated: false,
    exitCode: 0,
    error: null,
  };
}

export function macSuccess(stdout = "app-ok"): ExecHostResponse {
  return {
    ok: true,
    payload: {
      success: true,
      stdout,
      stderr: "",
      timedOut: false,
      exitCode: 0,
      error: null,
    },
  };
}

export function allowlistPolicy(params?: {
  autoAllowSkills?: boolean;
  agents?: Parameters<typeof approvalsStore.saveExecApprovals>[0]["agents"];
}): Parameters<typeof approvalsStore.saveExecApprovals>[0] {
  return {
    version: 1,
    defaults: {
      security: "allowlist",
      ask: "on-miss",
      askFallback: "deny",
      ...(params?.autoAllowSkills ? { autoAllowSkills: true } : {}),
    },
    agents: params?.agents ?? {},
  };
}

export function policy(
  security: ExecSecurity,
  ask: ExecAsk,
  askFallback: ExecSecurity,
  agents?: Parameters<typeof approvalsStore.saveExecApprovals>[0]["agents"],
): Parameters<typeof approvalsStore.saveExecApprovals>[0] {
  return {
    version: 1,
    defaults: { security, ask, askFallback },
    ...(agents === undefined ? {} : { agents }),
  };
}

export function createExactCommandPattern(commandText: string): string {
  return `=command:${crypto.createHash("sha256").update(commandText).digest("hex").slice(0, 16)}`;
}

export function expectOk(sendInvokeResult: MockedSendInvokeResult, payloadContains?: string) {
  const result = invokeResult(sendInvokeResult);
  expect(result.ok).toBe(true);
  if (payloadContains) {
    expect(result.payloadJSON).toContain(payloadContains);
  }
}

export function expectError(
  sendInvokeResult: MockedSendInvokeResult,
  expectedMessage: string,
  exact = false,
) {
  const result = invokeResult(sendInvokeResult);
  expect(result.ok).toBe(false);
  const message = result.error?.message;
  if (exact) {
    expect(message).toBe(expectedMessage);
  } else {
    expect(message).toContain(expectedMessage);
  }
}

export function firstMockCall<T extends unknown[]>(mock: { mock: { calls: T[] } }): T {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error("Expected mock call");
  }
  return call;
}

export function invokeResult(sendInvokeResult: MockedSendInvokeResult) {
  return firstMockCall(sendInvokeResult)[0];
}

export function runArgv(runCommand: MockedRunCommand) {
  return firstMockCall(runCommand)[0];
}

export function readMacCall(requestExecHost: MockedRequestExecHost) {
  return firstMockCall(requestExecHost)[0];
}

export function expectExecDeniedEvent(
  sendNodeEvent: MockedSendNodeEvent,
  reason = "approval-required",
): void {
  const call = sendNodeEvent.mock.calls[0];
  if (!call) {
    throw new Error("expected sendNodeEvent call");
  }
  expect(call[0]).toBe("exec.denied");
  expect(call[1]).toMatchObject({ reason });
}

export function expectApprovalRequired(
  sendNodeEvent: MockedSendNodeEvent,
  sendInvokeResult: MockedSendInvokeResult,
) {
  expectExecDeniedEvent(sendNodeEvent);
  expectError(sendInvokeResult, "SYSTEM_RUN_DENIED: approval required", true);
}

export function expectWriteDenied(params: {
  sendNodeEvent: MockedSendNodeEvent;
  sendInvokeResult: MockedSendInvokeResult;
}) {
  expectExecDeniedEvent(params.sendNodeEvent, "approval-state-write-failed");
  expect(invokeResult(params.sendInvokeResult)).toMatchObject({
    ok: false,
    error: {
      code: "SYSTEM_RUN_DENIED",
      message: "SYSTEM_RUN_DENIED: approval state could not be persisted",
    },
  });
}
