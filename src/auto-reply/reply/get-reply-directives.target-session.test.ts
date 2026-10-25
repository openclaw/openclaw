import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { SessionWorkStartInvalidatedError } from "../../config/sessions/lifecycle.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ModelSelectionLockedError } from "../../sessions/model-overrides.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { FinalizedTemplateContext as TemplateContext } from "../templating.js";
import * as directiveOverrides from "./get-reply-directives-apply.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
import {
  expectContinueResult,
  makeSessionEntry,
  makeTypingController,
  mockCallInput,
  replyDirectiveParams,
} from "./get-reply-directives.target-session.test-helpers.js";
import { withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import * as groups from "./groups.js";
import * as modelSelection from "./model-selection.js";
import { createModelSelectionStateFixture } from "./model-selection.test-support.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { buildTestCtx } from "./test-ctx.js";

afterEach(() => vi.restoreAllMocks());

vi.mock("./directive-handling.parse.js", async () => {
  const { parseInlineDirectivesForTargetSessionTest } =
    await import("./get-reply-directives.target-session.test-helpers.js");
  return {
    parseInlineSessionDirectives: vi.fn(parseInlineDirectivesForTargetSessionTest),
    resolveReplyDirectiveCommand: vi.fn(() => undefined),
  };
});

async function resolveHelloWithModelDefaults(params: {
  body?: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  agentCfg?: { reasoningDefault?: "off" | "on" | "stream"; verboseDefault?: "off" | "on" | "full" };
  commandAuthorized?: boolean;
  ctx?: Parameters<typeof buildTestCtx>[0];
  sessionCtx?: Partial<TemplateContext>;
  opts?: Parameters<typeof resolveReplyDirectives>[0]["opts"];
  cfg?: OpenClawConfig;
  modelError?: unknown;
  applyReply?: Extract<
    Awaited<ReturnType<typeof directiveOverrides.applyInlineDirectiveOverrides>>,
    { kind: "reply" }
  >;
}) {
  const {
    body = "hello",
    modelError,
    applyReply,
    ctx: ctxOverrides,
    sessionCtx: sessionOverrides,
    cfg,
    ...overrides
  } = params;
  const resolveDefaultReasoningLevel = vi.fn(async () => "on" as const);
  // mock-isolation: Select synthetic model facts without catalog/auth discovery.
  const selectModel = vi
    .spyOn(modelSelection, "createModelSelectionState")
    .mockImplementation(async (input) => {
      if (modelError) {
        throw modelError;
      }
      return {
        ...createModelSelectionStateFixture(input),
        resolveDefaultThinkingLevel: async () => "off",
        resolveDefaultReasoningLevel,
      };
    });
  // mock-isolation: Observe directive application without persisting session changes.
  const applyOverrides = vi
    .spyOn(directiveOverrides, "applyInlineDirectiveOverrides")
    .mockImplementation(
      async (input) =>
        applyReply ?? {
          kind: "continue",
          directives: input.directives,
          provider: input.provider,
          model: input.model,
          contextTokens: input.contextTokens,
        },
    );
  // mock-isolation: Observe the persisted group selected for system-event activation.
  const resolveGroupRequireMention = vi
    .spyOn(groups, "resolveGroupRequireMention")
    .mockResolvedValue(false);
  const typing = makeTypingController();
  const ctx = buildTestCtx({
    Body: body,
    CommandBody: body,
    CommandAuthorized: params.commandAuthorized ?? false,
    ...ctxOverrides,
  });
  const sessionCtx = {
    Body: body,
    BodyStripped: body,
    BodyForAgent: body,
    CommandBody: body,
    commandText: body,
    agentText: body,
    rawText: body,
    Provider: "whatsapp",
    ...sessionOverrides,
  } as TemplateContext;
  const result = await resolveReplyDirectives(
    replyDirectiveParams({
      ...overrides,
      cfg: withFullRuntimeReplyConfig({ ...cfg, commands: { text: true, ...cfg?.commands } }),
      ctx,
      sessionCtx,
      sessionEntry: params.sessionEntry ?? makeSessionEntry(),
      typing,
    }),
  );
  return {
    result,
    resolveDefaultReasoningLevel,
    typing,
    selectModel,
    applyOverrides,
    resolveGroupRequireMention,
  };
}

describe("resolveReplyDirectives", () => {
  it("passes persisted session identity into system-event group activation resolution", async () => {
    const wrapperSessionEntry = makeSessionEntry({ sessionId: "wrapper-session" });
    const targetSessionEntry = makeSessionEntry({
      sessionId: "target-session",
      chatType: "channel",
      groupId: "C123",
      delivery: normalizeSessionDeliveryState({ context: { channel: "slack", to: "C123" } }),
    });

    const { resolveGroupRequireMention } = await resolveHelloWithModelDefaults({
      sessionEntry: wrapperSessionEntry,
      sessionStore: { "agent:main:whatsapp:+2000": targetSessionEntry },
      ctx: { InternalTurnSource: "heartbeat" },
      sessionCtx: { InternalTurnSource: "heartbeat", Provider: undefined },
    });

    expect(mockCallInput(resolveGroupRequireMention).group).toMatchObject({
      channel: "slack",
      groupId: "C123",
    });
  });

  it.each([
    new SessionWorkStartInvalidatedError(
      'Session "agent:main:whatsapp:+2000" changed while starting work. Retry.',
    ),
    new ModelSelectionLockedError(),
  ])("returns a terminal reply for %s", async (error) => {
    const { result, typing, applyOverrides } = await resolveHelloWithModelDefaults({
      modelError: error,
    });
    expect(result).toEqual({
      kind: "reply",
      reply: { text: error.message, isError: true },
    });
    expect(typing.cleanup).toHaveBeenCalledOnce();
    expect(applyOverrides).not.toHaveBeenCalled();
  });

  it("preserves combined directive rejection delivery and its invocation rejection fact", async () => {
    const reply = { text: 'Model "openai/REJECTED_PRIVATE_TOKEN" is not allowed.', isError: true };
    const runState: ReplyOperationRunState = {};
    const { result } = await resolveHelloWithModelDefaults({
      body: "/model openai/REJECTED_PRIVATE_TOKEN\n/think high",
      commandAuthorized: true,
      opts: { [REPLY_OPERATION_RUN_STATE]: runState },
      applyReply: {
        kind: "reply",
        reply: { ...reply },
        preRunRejection: "session-directive-rejected",
      },
    });

    expect(result).toEqual({ kind: "reply", reply });
    expect(runState.preRunRejection).toBe("session-directive-rejected");
    if (result.kind !== "reply" || !result.reply || Array.isArray(result.reply)) {
      throw new Error("expected a single directive reply");
    }
    expect(getReplyPayloadMetadata(result.reply)?.deliverDespiteSourceReplySuppression).toBe(true);
  });

  it("preserves explicitly suppressed command-shaped text for the model", async () => {
    const body = "/model openai/gpt-5.5";
    const { result, selectModel, applyOverrides } = await resolveHelloWithModelDefaults({
      body,
      commandAuthorized: true,
      ctx: {
        CommandInterpretationSuppressed: true,
        CommandTurn: {
          kind: "normal",
          source: "message",
          authorized: false,
          body,
        },
      },
    });

    await expectContinueResult(result, { cleanedBody: body });
    expect(mockCallInput(selectModel).hasModelDirective).toBe(false);
    expect(mockCallInput(applyOverrides).directives).toMatchObject({
      hasModelDirective: false,
    });
  });

  const storedReasoning = () => makeSessionEntry({ reasoningLevel: "stream" });
  it.each<[string, () => Parameters<typeof resolveHelloWithModelDefaults>[0], string]>([
    ["untrusted stored level", () => ({ sessionEntry: storedReasoning() }), "off"],
    [
      "authorized stored level",
      () => ({ sessionEntry: storedReasoning(), commandAuthorized: true }),
      "stream",
    ],
    [
      "operator default",
      () => ({
        agentCfg: { reasoningDefault: "stream" },
        ctx: { GatewayClientScopes: ["operator.admin"] },
      }),
      "stream",
    ],
  ])("resolves reasoning for %s", async (_name, setup, expected) => {
    const params = setup();
    const { result, resolveDefaultReasoningLevel } = await resolveHelloWithModelDefaults(params);
    await expectContinueResult(result, { resolvedReasoningLevel: expected });
    expect(resolveDefaultReasoningLevel).not.toHaveBeenCalled();
  });

  it.each([
    ["this agent's default over the global default", "main", undefined, "full"],
    ["the global default when only another agent overrides it", "ops", undefined, "on"],
    ["a session override over this agent's default", "main", "off", "off"],
  ] as const)("resolves verbose to %s", async (_name, entryId, sessionVerbose, expected) => {
    const { result } = await resolveHelloWithModelDefaults({
      agentCfg: { verboseDefault: "on" },
      cfg: { agents: { entries: { [entryId]: { verboseDefault: "full" } } } },
      sessionEntry: makeSessionEntry(sessionVerbose ? { verboseLevel: sessionVerbose } : {}),
    });
    await expectContinueResult(result, { resolvedVerboseLevel: expected });
  });
});
