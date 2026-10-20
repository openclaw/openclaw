import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deliverAgentCommandResult } from "../../agents/command/delivery.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { defaultRuntime } from "../../runtime.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { replayAgentTurnIfCached } from "./agent-dedupe.js";
import { dispatchAgentRunFromGateway } from "./agent-run-dispatch.js";
import { createTrackedDispatch } from "./agent-run-dispatch.test-support.js";
import { setTestRpcSourceIdentity, testRpcSourceController } from "./rpc-source.test-support.js";

const mocks = vi.hoisted(() => ({
  command: vi.fn<typeof import("../../commands/agent.js").agentCommandFromGatewayIngress>(),
}));
vi.mock("../../commands/agent.js", () => ({ agentCommandFromGatewayIngress: mocks.command }));

const privateReply = "synthetic-private-agent-reply";
const privateDeliveryTarget = "synthetic-private-delivery-target";
const sessionCases = [
  ["ordinary", "ordinary", false, ["text", "delivery error"]],
  ["Incognito key", "incognito-private", false, ["text", "nested"]],
  ["Incognito entry", "private-entry", true, ["json", "delivery error"]],
] as const;
const outputMethods = ["log", "error", "writeJson", "writeStdout"] as const;
const outputOptions = {
  text: {},
  nested: { lane: "nested" },
  json: { json: true },
  "delivery error": {
    deliver: true,
    bestEffortDeliver: true,
    replyChannel: privateDeliveryTarget,
    replyTo: privateDeliveryTarget,
  },
} as const;

beforeEach(() => {
  mocks.command.mockReset();
  setActivePluginRegistry(createTestRegistry([]));
  for (const method of outputMethods) {
    vi.spyOn(defaultRuntime, method).mockImplementation(() => {});
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  setActivePluginRegistry(createTestRegistry([]));
});

function createDispatch(suffix: string, isIncognito: boolean) {
  const sessionKey = `agent:main:dashboard:${suffix}`;
  const { context, entry, runId } = createTrackedDispatch();
  setTestRpcSourceIdentity(entry, { sessionKey });
  return {
    admittedRunEntry: entry,
    ingressOpts: {
      message: "synthetic private prompt",
      sessionKey,
      allowModelOverride: false,
    },
    isIncognito,
    runId,
    dedupeKeys: [],
    abortController: testRpcSourceController(entry),
    cleanupAbortController: vi.fn(),
    io: { emitAcceptance: vi.fn(), emitFinal: vi.fn() },
    context,
  };
}

function expectDiagnostics(value: object, isPrivate: boolean, publicFields: object) {
  if (isPrivate) {
    expect(JSON.stringify(value)).not.toContain(privateReply);
  } else {
    expect(value).toMatchObject(publicFields);
  }
}

describe.each(sessionCases)(
  "Gateway agent diagnostic output: %s",
  (name, suffix, incognito, modes) => {
    const isPrivate = name !== "ordinary";

    it.each(modes)(
      "preserves the live result without persisting private %s output",
      async (mode) => {
        const params = createDispatch(suffix, incognito);
        mocks.command.mockImplementation(async (opts, runtime, deps) =>
          deliverAgentCommandResult({
            cfg: {},
            deps: deps ?? {},
            runtime,
            opts: { ...opts, ...outputOptions[mode] },
            outboundSession: undefined,
            sessionEntry: undefined,
            payloads: [{ text: privateReply }],
            result: { meta: { durationMs: 0 } },
          }),
        );

        await dispatchAgentRunFromGateway(params);

        const [frame] = params.io.emitFinal.mock.calls[0] ?? [];
        expect(frame).toEqual([
          true,
          expect.objectContaining({
            result: expect.objectContaining({
              payloads: [expect.objectContaining({ text: privateReply })],
            }),
          }),
          undefined,
        ]);
        const output = JSON.stringify(
          outputMethods.map((method) => vi.mocked(defaultRuntime[method]).mock.calls),
        );
        const marker = mode === "delivery error" ? privateDeliveryTarget : privateReply;
        if (isPrivate) {
          expect(output).not.toContain(marker);
        } else {
          expect(output).toContain(marker);
        }
        if (mode === "delivery error") {
          expect(frame?.[1]).toMatchObject({
            result: { deliveryStatus: { status: "failed", reason: "unknown_channel" } },
          });
        }
      },
    );

    it("keeps raw failures in the caller response and replay without Incognito diagnostics", async () => {
      const params = createDispatch(suffix, incognito);
      const dedupeKeys = [`agent:${params.runId}`];
      mocks.command.mockRejectedValueOnce(new Error(privateReply));

      await dispatchAgentRunFromGateway({ ...params, dedupeKeys });

      const [frame, diagnostics] = params.io.emitFinal.mock.calls[0] ?? [];
      expect(frame?.[1]).toMatchObject({ status: "error", summary: privateReply });
      expect(frame?.[2]).toMatchObject({ message: privateReply });
      const responseDiagnostics = { errorMessage: frame?.[2]?.message, ...diagnostics };
      expectDiagnostics(responseDiagnostics, isPrivate, { error: privateReply });

      rpcSourceTesting.clear();
      const emitAcceptance = vi.fn();
      expect(
        replayAgentTurnIfCached({
          preflight: { runId: params.runId, agentDedupeKeys: dedupeKeys },
          context: params.context,
          io: { emitAcceptance, emitFinal: vi.fn() },
        }),
      ).toBe(true);
      const [replayFrame, replayMetadata] = emitAcceptance.mock.calls[0] ?? [];
      expect(replayFrame).toEqual(frame);
      const replayDiagnostics = { errorMessage: replayFrame?.[2]?.message, ...replayMetadata };
      expectDiagnostics(replayDiagnostics, isPrivate, { cached: true, errorMessage: privateReply });
    });
  },
);
