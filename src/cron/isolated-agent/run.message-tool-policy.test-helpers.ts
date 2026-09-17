import { expect } from "vitest";
import { createRequireRecord } from "../../plugin-sdk/test-fixtures.js";
import {
  dispatchCronDeliveryMock,
  runCliAgentMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

export function makeMessageToolPolicyJob(
  delivery: Record<string, unknown> = { mode: "none" },
  payload: Record<string, unknown> = { kind: "agentTurn", message: "send a message" },
) {
  return {
    id: "message-tool-policy",
    name: "Message Tool Policy",
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    payload,
    delivery,
  } as never;
}

export function makeAnnounceMessageToolJob(
  options: {
    id?: string;
    name?: string;
    delivery?: Record<string, unknown>;
    payload?: Record<string, unknown>;
  } = {},
) {
  return {
    id: options.id ?? "message-tool-policy",
    name: options.name ?? "Message Tool Policy",
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "send a message", ...options.payload },
    delivery: { mode: "announce", channel: "messagechat", to: "123", ...options.delivery },
  } as never;
}

export function makeParams() {
  return {
    cfg: {},
    deps: {} as never,
    job: makeMessageToolPolicyJob(),
    message: "send a message",
    sessionKey: "cron:message-tool-policy",
  };
}

export function makeAnnounceDeliveryPlan(overrides: Record<string, unknown> = {}) {
  return {
    requested: true,
    mode: "announce",
    channel: "messagechat",
    to: "123",
    ...overrides,
  };
}

export function makeResolvedAnnounceTarget(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    channel: "messagechat",
    to: "123",
    accountId: undefined,
    threadId: undefined,
    mode: "explicit",
    ...overrides,
  };
}

export function makeMessageToolRunResult(messagingToolSentTargets: Array<Record<string, unknown>>) {
  return {
    payloads: [{ text: "sent" }],
    didSendViaMessagingTool: true,
    messagingToolSentTargets,
    meta: { agentMeta: { usage: { input: 10, output: 20 } } },
  };
}

const requireRecord = createRequireRecord("record", "expected-label-object");

export function expectRecordFields(
  value: unknown,
  expected: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  const record = requireRecord(value, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], `${label}.${key}`).toEqual(expectedValue);
  }
  return record;
}

export function getMockCallArg(
  mock: { mock: { calls: readonly unknown[][] } },
  callIndex: number,
  argIndex: number,
  label: string,
): unknown {
  const call = (mock.mock.calls as unknown[][])[callIndex];
  if (!call) {
    throw new Error(`expected ${label} call ${callIndex}`);
  }
  return call[argIndex];
}

export function expectEmbeddedRunFields(
  expected: Record<string, unknown>,
): Record<string, unknown> {
  return expectRecordFields(
    getMockCallArg(runEmbeddedAgentMock, 0, 0, "embedded run"),
    expected,
    "embedded run params",
  );
}

export function resolveRunPrompt(
  runParams: Record<string, unknown>,
  messageToolAvailable: boolean,
): string {
  const prompt = runParams.prompt;
  if (typeof prompt !== "string") {
    throw new Error("expected run prompt to be a string");
  }
  const finalizer = runParams.finalizePromptForResolvedTools;
  if (typeof finalizer !== "function") {
    return prompt;
  }
  const finalized = finalizer({ prompt, messageToolAvailable });
  if (typeof finalized !== "string") {
    throw new Error("expected finalized run prompt to be a string");
  }
  return finalized;
}

export function expectEmbeddedRunPrompt(messageToolAvailable = false): string {
  return resolveRunPrompt(expectEmbeddedRunFields({}), messageToolAvailable);
}

export function expectCliRunPrompt(messageToolAvailable = false): string {
  return resolveRunPrompt(
    expectRecordFields(getMockCallArg(runCliAgentMock, 0, 0, "CLI run"), {}, "CLI run params"),
    messageToolAvailable,
  );
}

export function expectDispatchFields(expected: Record<string, unknown>): Record<string, unknown> {
  return expectRecordFields(
    getMockCallArg(dispatchCronDeliveryMock, 0, 0, "cron delivery dispatch"),
    expected,
    "cron delivery dispatch params",
  );
}

export function expectDeliveryFields(
  delivery: unknown,
  expected: Record<string, unknown>,
): Record<string, unknown> {
  return expectRecordFields(delivery, expected, "cron delivery result");
}
