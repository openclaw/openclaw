import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { completeAcpSessionFixture } from "./dispatch-from-config.acp-fixture.test-support.js";
import {
  acpMocks,
  hookMocks,
  mocks,
  sessionStoreMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  createAcpRuntime,
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  setNoAbort,
} from "./dispatch-from-config.test-support.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);
beforeEach(describe0BeforeEach0);

it("strips split private prompt context before routing live ACP replies through its dispatch hook", async () => {
  setNoAbort();
  const history =
    "[Chat messages since your last reply - for context]\n[Discord] Alice: private history\n\n";
  const marker = "[Current message - respond to this]";
  const privateXml = '<function_calls><invoke name="exec">private XML</invoke></function_calls>';
  const privateInbound = "private inbound paragraph";
  const conversationContext = `${history}${marker}\n${privateXml}\n${privateInbound}`;
  const sessionKey = "agent:codex-acp:privacy-session";
  const runtime = createAcpRuntime([
    ...[
      "Visible answer before. ",
      `${history}${marker.slice(0, 12)}`,
      `${marker.slice(12)}\n${privateXml.slice(0, 25)}`,
      `${privateXml.slice(25)}\n${privateInbound} Visible answer after.`,
    ].map((text) => ({ type: "text_delta" as const, text })),
    { type: "done" },
  ]);
  sessionStoreMocks.currentEntry = { sessionId: "privacy-session", updatedAt: Date.now() };
  acpMocks.readAcpSessionEntry.mockReturnValue(
    completeAcpSessionFixture(
      {
        entry: sessionStoreMocks.currentEntry,
        acp: { agent: "codex", runtimeSessionName: "runtime:privacy", lastActivityAt: Date.now() },
      },
      { sessionKey, storePath: "/tmp/mock-sessions.json" },
    ),
  );
  acpMocks.requireAcpRuntimeBackend.mockReturnValue({ id: "acpx", runtime });

  const dispatcher = createReplyDispatcher({ deliver: vi.fn(async () => {}) });
  await dispatchReplyFromConfig({
    ctx: buildTestCtx({
      Body: conversationContext,
      BodyForAgent: conversationContext,
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
      SessionKey: sessionKey,
    }),
    cfg: {
      acp: { enabled: true, dispatch: { enabled: true }, stream: { deliveryMode: "live" } },
      session: { sendPolicy: { default: "allow" } },
    },
    dispatcher,
  });
  dispatcher.markComplete();
  await dispatcher.waitForIdle();

  expect(hookMocks.runner.runReplyDispatch).toHaveBeenCalledOnce();
  expect(runtime.runTurn).toHaveBeenCalledOnce();
  const routedPayloads = mocks.routeReply.mock.calls.map(([value]) => {
    const routed = value as { channel: string; payload: { text?: string } };
    expect(routed.channel).toBe("telegram");
    return routed.payload.text ?? "";
  });
  expect(routedPayloads.slice(0, 2)).toEqual(["Visible answer before.", "Visible answer after."]);
  expect(routedPayloads.join(" ")).not.toMatch(
    /\[Chat messages since your last reply|private history|\[Current message - respond to this\]|private XML|private inbound paragraph/,
  );
});
