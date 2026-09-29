import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deliverAgentCommandResult } from "../../agents/command/delivery.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { defaultRuntime } from "../../runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { replayAgentTurnIfCached } from "./agent-dedupe.js";
import { dispatchAgentRunFromGateway } from "./agent-run-dispatch.js";
import { createTrackedDispatch } from "./agent-run-dispatch.test-support.js";

const mocks = vi.hoisted(() => ({
  command: vi.fn<typeof import("../../commands/agent.js").agentCommandFromGatewayIngress>(),
}));
vi.mock("../../commands/agent.js", () => ({ agentCommandFromGatewayIngress: mocks.command }));

const privateReply = "synthetic-private-agent-reply";
const privateDeliveryTarget = "synthetic-private-delivery-target";
const sessionCases = [
  { name: "ordinary", key: "agent:main:dashboard:ordinary", isIncognito: false },
  { name: "Incognito key", key: "agent:main:dashboard:incognito-private", isIncognito: false },
  { name: "Incognito entry", key: "agent:main:dashboard:private-entry", isIncognito: true },
] as const;

beforeEach(() => {
  mocks.command.mockReset();
  setActivePluginRegistry(createTestRegistry([]));
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "writeStdout").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  setActivePluginRegistry(createTestRegistry([]));
});

function createDispatch(session: (typeof sessionCases)[number]) {
  const { context, entry, runId } = createTrackedDispatch();
  entry.sessionKey = session.key;
  const emitFinal = vi.fn();
  return {
    admittedRunEntry: entry,
    ingressOpts: {
      message: "synthetic private prompt",
      sessionKey: session.key,
      allowModelOverride: false,
    },
    isIncognito: session.isIncognito,
    runId,
    dedupeKeys: [],
    abortController: entry.controller,
    cleanupAbortController: vi.fn(),
    io: { emitAcceptance: vi.fn(), emitFinal },
    context,
  };
}

describe.each(sessionCases)("Gateway agent diagnostic output: $name", (session) => {
  const isPrivate = session.name !== "ordinary";

  it.each(["text", "nested", "json", "delivery error"] as const)(
    "preserves the live result without persisting private %s output",
    async (mode) => {
      const params = createDispatch(session);
      mocks.command.mockImplementation(async (opts, runtime, deps) =>
        deliverAgentCommandResult({
          cfg: {},
          deps: deps ?? {},
          runtime,
          opts: {
            ...opts,
            ...(mode === "nested" ? { lane: "nested" } : {}),
            ...(mode === "json" ? { json: true } : {}),
            ...(mode === "delivery error"
              ? {
                  deliver: true,
                  bestEffortDeliver: true,
                  replyChannel: privateDeliveryTarget,
                  replyTo: privateDeliveryTarget,
                }
              : {}),
          },
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
      const output = JSON.stringify([
        vi.mocked(defaultRuntime.log).mock.calls,
        vi.mocked(defaultRuntime.error).mock.calls,
        vi.mocked(defaultRuntime.writeJson).mock.calls,
        vi.mocked(defaultRuntime.writeStdout).mock.calls,
      ]);
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
    const params = createDispatch(session);
    const dedupeKeys = [`agent:${params.runId}`];
    mocks.command.mockRejectedValueOnce(new Error(privateReply));

    await dispatchAgentRunFromGateway({ ...params, dedupeKeys });

    const [frame, diagnostics] = params.io.emitFinal.mock.calls[0] ?? [];
    expect(frame?.[1]).toMatchObject({ status: "error", summary: privateReply });
    expect(frame?.[2]).toMatchObject({ message: privateReply });
    const responseDiagnostics = { errorMessage: frame?.[2]?.message, ...diagnostics };
    if (isPrivate) {
      expect(JSON.stringify(responseDiagnostics)).not.toContain(privateReply);
    } else {
      expect(diagnostics).toMatchObject({ error: privateReply });
    }

    params.context.chatAbortControllers.clear();
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
    if (isPrivate) {
      expect(JSON.stringify(replayDiagnostics)).not.toContain(privateReply);
    } else {
      expect(replayDiagnostics).toMatchObject({ cached: true, errorMessage: privateReply });
    }
  });
});
