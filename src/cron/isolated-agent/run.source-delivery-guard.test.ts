import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import type { SessionEventTarget } from "../../auto-reply/reply/session-event-contract.js";
import { captureSessionEventTargetForHost } from "../../auto-reply/reply/session-event-target.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { finalizeCronPromptForResolvedTools } from "./run-delivery-trace.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  makeCronSessionEntry,
  mockRunCronFallbackPassthrough,
  resolveConfiguredModelRefMock,
  resolveCronDeliveryPlanMock,
  resolveCronSessionMock,
  resolveDeliveryTargetMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const { resolveCronDeliveryPlan } =
  await vi.importActual<typeof import("../delivery-plan.js")>("../delivery-plan.js");
const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

// mock-isolation: The delivery restriction comes from the real run owner, independently of storage.
vi.mock("../../config/sessions/session-entry-read-runtime.js", () => ({
  withSessionEntryReadOnlyInWorker: vi.fn<
    typeof import("../../config/sessions/session-entry-read-runtime.js").withSessionEntryReadOnlyInWorker
  >(async (_scope, assertCurrent, consume) => {
    assertCurrent();
    return await consume({ ok: true, value: undefined }, { kind: "unresolved", assertCurrent });
  }),
}));

describe("cron source delivery policy", () => {
  setupRunCronIsolatedAgentTurnSuite();
  beforeEach(() => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockImplementation(resolveCronDeliveryPlan);
  });

  it.each([
    { mode: "none", disabled: false, explicitTarget: false, channel: "messagechat" },
    { mode: "announce", disabled: false, explicitTarget: true, channel: "messagechat" },
    { mode: "webhook", disabled: true, explicitTarget: false, channel: undefined },
    { mode: undefined, disabled: false, explicitTarget: true, channel: "messagechat" },
  ] as const)("runs delivery mode $mode with its tool and completion policy", async (row) => {
    resolveDeliveryTargetMock.mockResolvedValue({
      ok: true,
      channel: "messagechat",
      to: "123",
      accountId: "acct-1",
      threadId: "thread-99",
    });
    let capturedTarget: SessionEventTarget | undefined;
    runEmbeddedAgentMock.mockImplementationOnce(async (runParams: RunEmbeddedAgentParams) => {
      assert(runParams.preparedRunAdmission && runParams.agentId && runParams.sessionKey);
      const admitted = await runParams.preparedRunAdmission.admit("gateway", runParams.runId);
      const caller = createAdmittedGatewayToolCallerIdentity({
        admittedRunContext: admitted,
        agentId: runParams.agentId,
        sessionKey: runParams.sessionKey,
      });
      assert(caller);
      const previousConfig = getRuntimeConfigSnapshot();
      setRuntimeConfigSnapshot(runParams.config ?? {});
      try {
        capturedTarget = await withGatewayToolCallerIdentity(caller, () =>
          captureSessionEventTargetForHost(caller.agentId, caller.sessionKey),
        );
      } finally {
        if (previousConfig) {
          setRuntimeConfigSnapshot(previousConfig);
        } else {
          clearRuntimeConfigSnapshot();
        }
      }
      return { payloads: [{ text: "test output" }], meta: { agentMeta: {} } };
    });
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          schedule: { kind: "every", everyMs: 60_000 },
          delivery: row.mode ? { mode: row.mode, channel: "messagechat", to: "123" } : undefined,
        }),
      }),
    );
    expect(result.status).toBe("ok");
    expect(capturedTarget).toMatchObject({
      deliver: row.mode === "none" || row.mode === "webhook" ? false : undefined,
    });
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedAgentMock.mock.calls[0]?.[0]).toMatchObject({
      sourceReplyDeliveryMode: undefined,
      terminalReplyExpectation: "optional",
      disableMessageTool: row.disabled,
      forceMessageTool: false,
      requireExplicitMessageTarget: row.explicitTarget,
      messageChannel: row.channel,
      ...(row.channel
        ? { messageTo: "123", agentAccountId: "acct-1", messageThreadId: "thread-99" }
        : {}),
    });
  });

  it("rejects required message-tool delivery when the runtime cannot expose the tool", () => {
    expect(() =>
      finalizeCronPromptForResolvedTools({
        prompt: "send a message",
        messageToolAvailable: false,
        deliveryRequested: true,
        resolvedDelivery: { ok: true, channel: "messagechat", to: "123" },
        sourceDelivery: {
          owner: "message_tool_then_direct_fallback",
          reason: "cron_announce",
          target: { channel: "messagechat", to: "123" },
          normalFinal: "private",
          sourceReplyDeliveryMode: "message_tool_only",
          messageTool: {
            enabled: true,
            force: true,
            requireExplicitTarget: false,
            requireExplicitTargetEvidence: false,
          },
          fallback: { directDelivery: true, skipWhenMessageToolSentToTarget: true },
        },
      }),
    ).toThrow("Cron source delivery requires the message tool");
  });

  it("honors an explicit OpenClaw runtime override during cron execution", async () => {
    resolveConfiguredModelRefMock.mockReturnValue({ provider: "openai", model: "gpt-5.6-luna" });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        sessionEntry: makeCronSessionEntry({
          agentRuntimeOverride: "openclaw",
          agentHarnessId: "codex",
        }),
      }),
    );
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        cfg: {
          agents: {
            defaults: { models: { "openai/gpt-5.6-luna": { agentRuntime: { id: "codex" } } } },
          },
        },
        job: makeIsolatedAgentJobFixture({
          payload: { kind: "agentTurn", message: "run an Ultra task", thinking: "ultra" },
        }),
      }),
    );
    expect(result.status).toBe("ok");
    expect(runEmbeddedAgentMock.mock.calls[0]?.[0]).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-luna",
      thinkLevel: "ultra",
      agentHarnessRuntimeOverride: "openclaw",
    });
    expect(runEmbeddedAgentMock.mock.calls[0]?.[0]).not.toHaveProperty("agentHarnessId");
  });
});
