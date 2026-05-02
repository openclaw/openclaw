import { afterEach, describe, expect, it } from "vitest";
import type { PolicyModule } from "./action-sink-policy.js";
import { policyResult } from "./action-sink-policy.js";
import {
  __testing,
  evaluateConfiguredActionSinkPolicySync,
  enforceActionSinkPolicy,
  enforceActionSinkPolicySync,
} from "./action-sink-runtime.js";

const blockingModule: PolicyModule = {
  id: "test-block",
  evaluate(request) {
    return policyResult({
      policyId: "test-block",
      decision: "block",
      reasonCode: "invalid_request",
      reason: `blocked ${request.actionType}`,
      correlationId: request.correlationId,
    });
  },
};

describe("action sink runtime enforcement", () => {
  afterEach(() => {
    __testing.setActionSinkEnforcementOverride(null);
    delete process.env.OPENCLAW_ACTION_SINK_EXTERNAL_ALLOWLIST;
  });

  it("throws before async execution when policy blocks", async () => {
    __testing.setActionSinkEnforcementOverride({ modules: [blockingModule] });

    await expect(
      enforceActionSinkPolicy({
        policyVersion: "v1",
        actionType: "message_send",
        payloadSummary: "hello",
      }),
    ).rejects.toThrow("blocked message_send");
  });

  it("throws before sync execution when policy blocks", () => {
    __testing.setActionSinkEnforcementOverride({ modules: [blockingModule] });

    expect(() =>
      enforceActionSinkPolicySync({
        policyVersion: "v1",
        actionType: "status_transition",
        context: { status: "succeeded" },
      }),
    ).toThrow("blocked status_transition");
  });

  it("blocks completion claims without evidence by default", async () => {
    await expect(
      enforceActionSinkPolicy({
        policyVersion: "v1",
        actionType: "completion_claim",
        payloadSummary: "This is done.",
      }),
    ).rejects.toThrow("Completion/status claim requires review and QA evidence");
  });

  it("allows approved exec completion follow-ups to the original outbound target", async () => {
    await expect(
      enforceActionSinkPolicy({
        policyVersion: "v1",
        actionType: "completion_claim",
        toolName: "outbound.deliver",
        targetResource: "telegram:chat-1",
        payloadSummary: "The approved command completed successfully.",
        actor: { id: "main", sessionKey: "agent:main:telegram:chat-1" },
        context: {
          channel: "telegram",
          to: "chat-1",
          accountId: "acct-1",
          sessionKey: "agent:main:telegram:chat-1",
          actionSinkContext: {
            source: "approved_exec_completion",
            approvalId: "req-1",
            idempotencyKey: "exec-approval-followup:req-1",
            sessionKey: "agent:main:telegram:chat-1",
            channel: "telegram",
            to: "chat-1",
            accountId: "acct-1",
          },
        },
      }),
    ).resolves.toMatchObject({ decision: "allow" });
  });

  it("does not allow approved exec completion context for generic outbound tools", async () => {
    await expect(
      enforceActionSinkPolicy({
        policyVersion: "v1",
        actionType: "completion_claim",
        toolName: "message.send",
        targetResource: "telegram:chat-1",
        payloadSummary: "The approved command completed successfully.",
        actor: { id: "main", sessionKey: "agent:main:telegram:chat-1" },
        context: {
          channel: "telegram",
          to: "chat-1",
          sessionKey: "agent:main:telegram:chat-1",
          actionSinkContext: {
            source: "approved_exec_completion",
            approvalId: "req-1",
            idempotencyKey: "exec-approval-followup:req-1",
            sessionKey: "agent:main:telegram:chat-1",
            channel: "telegram",
            to: "chat-1",
          },
        },
      }),
    ).rejects.toThrow("Completion/status claim requires review and QA evidence");
  });

  it("does not allow approved exec completion context for a different target", async () => {
    await expect(
      enforceActionSinkPolicy({
        policyVersion: "v1",
        actionType: "completion_claim",
        toolName: "outbound.deliver",
        targetResource: "telegram:chat-1",
        payloadSummary: "The approved command completed successfully.",
        actor: { id: "main", sessionKey: "agent:main:telegram:chat-1" },
        context: {
          channel: "telegram",
          to: "chat-1",
          sessionKey: "agent:main:telegram:chat-1",
          actionSinkContext: {
            source: "approved_exec_completion",
            approvalId: "req-1",
            idempotencyKey: "exec-approval-followup:req-1",
            sessionKey: "agent:main:telegram:chat-1",
            channel: "telegram",
            to: "chat-2",
          },
        },
      }),
    ).rejects.toThrow("Completion/status claim requires review and QA evidence");
  });

  it("allows task registry delivery follow-ups to the original outbound target", async () => {
    await expect(
      enforceActionSinkPolicy({
        policyVersion: "v1",
        actionType: "completion_claim",
        toolName: "outbound.deliver",
        targetResource: "telegram:chat-1",
        payloadSummary: "Background task done: ACP background task.",
        actor: { id: "main", sessionKey: "agent:main:telegram:chat-1" },
        context: {
          channel: "telegram",
          to: "chat-1",
          accountId: "acct-1",
          sessionKey: "agent:main:telegram:chat-1",
          actionSinkContext: {
            source: "task_registry_delivery",
            taskId: "task-1",
            idempotencyKey: "task-terminal:task-1:succeeded:default",
            sessionKey: "agent:main:telegram:chat-1",
            channel: "telegram",
            to: "chat-1",
            accountId: "acct-1",
            delivery: "terminal",
            status: "succeeded",
          },
        },
      }),
    ).resolves.toMatchObject({ decision: "allow" });
  });

  it("does not allow task registry delivery context for generic outbound tools", async () => {
    await expect(
      enforceActionSinkPolicy({
        policyVersion: "v1",
        actionType: "completion_claim",
        toolName: "message.send",
        targetResource: "telegram:chat-1",
        payloadSummary: "Background task done: ACP background task.",
        actor: { id: "main", sessionKey: "agent:main:telegram:chat-1" },
        context: {
          channel: "telegram",
          to: "chat-1",
          sessionKey: "agent:main:telegram:chat-1",
          actionSinkContext: {
            source: "task_registry_delivery",
            taskId: "task-1",
            idempotencyKey: "task-terminal:task-1:succeeded:default",
            sessionKey: "agent:main:telegram:chat-1",
            channel: "telegram",
            to: "chat-1",
            delivery: "terminal",
          },
        },
      }),
    ).rejects.toThrow("Completion/status claim requires review and QA evidence");
  });

  it("does not allow task registry delivery context for a different target", async () => {
    await expect(
      enforceActionSinkPolicy({
        policyVersion: "v1",
        actionType: "completion_claim",
        toolName: "outbound.deliver",
        targetResource: "telegram:chat-1",
        payloadSummary: "Background task done: ACP background task.",
        actor: { id: "main", sessionKey: "agent:main:telegram:chat-1" },
        context: {
          channel: "telegram",
          to: "chat-1",
          sessionKey: "agent:main:telegram:chat-1",
          actionSinkContext: {
            source: "task_registry_delivery",
            taskId: "task-1",
            idempotencyKey: "task-terminal:task-1:succeeded:default",
            sessionKey: "agent:main:telegram:chat-1",
            channel: "telegram",
            to: "chat-2",
            delivery: "terminal",
          },
        },
      }),
    ).rejects.toThrow("Completion/status claim requires review and QA evidence");
  });

  it("allows environment-scoped external message targets", () => {
    process.env.OPENCLAW_ACTION_SINK_EXTERNAL_ALLOWLIST = "telegram:-1003872638243|message_send";

    expect(
      evaluateConfiguredActionSinkPolicySync({
        policyVersion: "v1",
        actionType: "message_send",
        targetResource: "telegram:-1003872638243",
        payloadSummary: "ping",
      }).decision,
    ).toBe("allow");

    expect(
      evaluateConfiguredActionSinkPolicySync({
        policyVersion: "v1",
        actionType: "message_send",
        targetResource: "telegram:-1000000000000",
        payloadSummary: "ping",
      }).decision,
    ).toBe("requireApproval");
  });

  it("requires approval for external shell network commands unless exec approval is present", async () => {
    await expect(
      enforceActionSinkPolicy({
        policyVersion: "v1",
        actionType: "shell_exec",
        payloadSummary: "curl -fsS https://example.test",
        context: { command: "curl -fsS https://example.test" },
      }),
    ).rejects.toMatchObject({
      name: "ActionSinkPolicyDeniedError",
      decision: "requireApproval",
      reasonCode: "shell_risk",
    });

    await expect(
      enforceActionSinkPolicy({
        policyVersion: "v1",
        actionType: "shell_exec",
        payloadSummary: "curl -fsS https://example.test",
        context: {
          command: "curl -fsS https://example.test",
          actionSinkApproval: {
            source: "exec-approval",
            approvalId: "req-1",
          },
        },
      }),
    ).resolves.toMatchObject({ decision: "allow" });
  });
});
