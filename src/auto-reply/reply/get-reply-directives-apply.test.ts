import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as sandboxRuntime from "../../agents/sandbox.js";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "../../sessions/model-overrides.js";
import type { ReplyPayload } from "../types.js";
import { applyMixedDirectives } from "./directive-handling.mixed-inline.test-helpers.js";
import type { HandleDirectiveOnlyParams } from "./directive-handling.params.js";
import { parseInlineSessionDirectives } from "./directive-handling.parse.js";
import { applyInlineDirectiveOverrides } from "./get-reply-directives-apply.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
import { replyDirectiveParams } from "./get-reply-directives.target-session.test-helpers.js";
import { createModelSelectionStateFixture } from "./model-selection.test-support.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { buildTestCtx } from "./test-ctx.js";
import { createMockTypingController } from "./test-helpers.js";
import { createTypingController } from "./typing.js";

const mocks = vi.hoisted(() => ({
  handleDirective:
    vi.fn<
      (params: HandleDirectiveOnlyParams) => Promise<import("../types.js").ReplyPayload | undefined>
    >(),
  applyModelSelection: vi.fn(),
  systemEvent: vi.fn(),
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => mocks.systemEvent(...args),
}));

vi.mock("./directive-handling.impl.js", () => ({
  handleDirectiveOnly: (params: HandleDirectiveOnlyParams) => mocks.handleDirective(params),
}));

vi.mock("../../model-picker/apply-session-model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../model-picker/apply-session-model-selection.js")>()),
  applySessionModelSelectionInternal: (...args: unknown[]) => mocks.applyModelSelection(...args),
}));

beforeEach(() => {
  mocks.handleDirective.mockReset();
  mocks.applyModelSelection.mockReset();
  mocks.systemEvent.mockReset();
});

function directiveParams(
  body: string,
  overrides: Partial<Parameters<typeof applyInlineDirectiveOverrides>[0]> = {},
): Parameters<typeof applyInlineDirectiveOverrides>[0] {
  const model = overrides.model ?? "gpt-5.5";
  const sessionEntry = overrides.sessionEntry ?? { sessionId: "session-1", updatedAt: 1 };
  const directives = parseInlineSessionDirectives(body);
  return {
    ctx: buildTestCtx({ Body: body, CommandAuthorized: true }),
    cfg: {},
    agentId: "main",
    agentDir: "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    agentCfg: {},
    sessionEntry,
    sessionStore: { "agent:main:main": sessionEntry },
    sessionKey: "agent:main:main",
    sessionScope: undefined,
    isGroup: false,
    allowTextCommands: true,
    command: {
      surface: "webchat",
      channel: "webchat",
      ownerList: [],
      senderIsOwner: true,
      isAuthorizedSender: true,
      rawBodyNormalized: body,
      commandBodyNormalized: body,
    },
    directives,
    elevatedEnabled: true,
    elevatedAllowed: true,
    elevatedFailures: [],
    defaultProvider: "openai",
    defaultModel: model,
    aliasIndex: { byAlias: new Map(), byKey: new Map() },
    provider: "openai",
    model,
    modelState: createModelSelectionStateFixture({ agentCfg: {}, provider: "openai", model }),
    initialModelLabel: `openai/${model}`,
    formatModelSwitchEvent: (label) => label,
    resolvedElevatedLevel: "off",
    defaultActivation: () => "always",
    contextTokens: 8192,
    typing: createMockTypingController(),
    ...overrides,
  };
}

async function runRuntimePolicyDirective(
  params: Pick<HandleDirectiveOnlyParams, "cfg" | "agentId" | "sessionKey" | "ctx">,
  expectedRuntime: Partial<ReturnType<typeof sandboxRuntime.resolveSandboxRuntimeStatus>>,
) {
  const { handleDirectiveOnly } = await vi.importActual<
    typeof import("./directive-handling.impl.js")
  >("./directive-handling.impl.js");
  using runtime = vi.spyOn(sandboxRuntime, "resolveSandboxRuntimeStatusAsync");
  const sessionEntry = { sessionId: "runtime-policy", updatedAt: 1 };
  try {
    return await handleDirectiveOnly({
      ...params,
      directives: parseInlineSessionDirectives("/elevated on"),
      sessionEntry,
      sessionStore: { [params.sessionKey]: sessionEntry },
      elevatedEnabled: false,
      elevatedAllowed: false,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      provider: "openai",
      model: "gpt-5.5",
      initialModelLabel: "openai/gpt-5.5",
      formatModelSwitchEvent: (label) => label,
      aliasIndex: { byAlias: new Map(), byKey: new Map() },
      allowedModelKeys: new Set(),
      allowedModelCatalog: [],
      resetModelOverride: false,
    });
  } finally {
    expect(runtime).toHaveBeenCalledOnce();
    const result = runtime.mock.results[0];
    expect(result?.type).toBe("return");
    if (result?.type === "return") {
      expect(await result.value).toMatchObject(expectedRuntime);
    }
  }
}

function expectRejectedDirective(
  result: Awaited<ReturnType<typeof applyInlineDirectiveOverrides>>,
  typing: ReturnType<typeof createMockTypingController>,
  reply: ReplyPayload,
  preRunRejection = "session-directive-rejected",
) {
  expect(result).toEqual({ kind: "reply", reply, preRunRejection });
  expect(typing.cleanup).toHaveBeenCalledOnce();
}

describe("applyInlineDirectiveOverrides", () => {
  it.each(["thinking", "catalog"] as const)(
    "cancels a reply directive during %s discovery without consuming its late result",
    async (stage) => {
      const held = createDeferred();
      const entered = createDeferred();
      const controller = new AbortController();
      const discover = async <T>(at: typeof stage, value: T): Promise<T> => {
        if (stage === at) {
          entered.resolve();
          await held.promise;
        }
        return value;
      };
      const pending = applyMixedDirectives({
        body: stage === "thinking" ? "/think low" : "/status",
        abortSignal: controller.signal,
        resolveDefaultThinkingLevel: () => discover("thinking", "off" as const),
        resolveThinkingCatalog: () => discover("catalog", []),
      });
      await entered.promise;
      const outcome = pending.then(
        () => "completed",
        (error: unknown) => (error instanceof Error ? error.name : "unknown"),
      );
      controller.abort();
      try {
        expect(
          await Promise.race([
            outcome,
            new Promise<string>((resolve) => {
              setImmediate(() => resolve("pending"));
            }),
          ]),
        ).toBe("AbortError");
        expect(mocks.handleDirective).not.toHaveBeenCalled();
      } finally {
        held.resolve();
        await Promise.allSettled([pending]);
      }
    },
  );

  it("returns the elevated denial for a prepared global owner", async () => {
    const ctx = buildTestCtx({
      Body: "/elevated on",
      CommandBody: "/elevated on",
      CommandAuthorized: true,
      SessionKey: "global",
      Provider: "webchat",
      Surface: "webchat",
    });
    const sessionEntry = { sessionId: "global-session", updatedAt: 1 };
    const runState: ReplyOperationRunState = {};
    const opts = { [REPLY_OPERATION_RUN_STATE]: runState, suppressTyping: true };
    const result = await resolveReplyDirectives(
      replyDirectiveParams({
        ctx,
        cfg: {
          agents: { ownership: "explicit", entries: { target: {}, other: {} } },
          tools: { elevated: { enabled: false } },
        },
        agentId: "target",
        agentDir: "/tmp/target-agent",
        workspaceDir: "/tmp/workspace",
        sessionCtx: ctx,
        sessionEntry,
        storePath: undefined,
        sessionKey: "global",
        sessionScope: "global",
        triggerBodyNormalized: "/elevated on",
        commandAuthorized: true,
        defaultModel: "gpt-5.5",
        model: "gpt-5.5",
        typing: createTypingController({}),
        opts,
      }),
    );

    expect(result).toMatchObject({
      kind: "reply",
      reply: { text: expect.stringContaining("elevated is not available") },
    });
    expect(runState.preRunRejection).toBe("session-directive-rejected");
    expect(mocks.handleDirective).not.toHaveBeenCalled();
  });

  it("keeps the prepared global owner through directive application and context budgeting", async () => {
    const { result } = await applyMixedDirectives({
      body: "hello /verbose on",
      cfg: { agents: { ownership: "explicit", entries: { main: {}, other: {} } } },
      sessionKey: "global",
    });

    expect(result.kind).toBe("continue");
    expect(mocks.handleDirective).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main" }),
    );
  });

  it.each([false, true])(
    "keeps the active agent with independent policy=%s",
    async (independent) => {
      const pending = runRuntimePolicyDirective(
        {
          cfg: independent
            ? {
                agents: {
                  ownership: "explicit",
                  entries: {
                    target: { sandbox: { mode: "off" } },
                    main: { sandbox: { mode: "all" } },
                  },
                },
              }
            : {
                session: { scope: "global" },
                agents: { ownership: "explicit", entries: { target: {}, other: {} } },
              },
          agentId: "target",
          sessionKey: independent ? "agent:target:main" : "global",
          ctx: buildTestCtx(
            independent
              ? { RuntimePolicySessionKey: "agent:main:group" }
              : {
                  Provider: "telegram",
                  ChatType: "direct",
                  SenderId: "sender",
                  AccountId: "default",
                },
          ),
        },
        {
          agentId: "target",
          classificationSessionKey: independent
            ? "agent:main:group"
            : "agent:target:telegram:default:direct:sender",
          ...(independent ? { sandboxed: true } : {}),
        },
      );
      if (independent) {
        await expect(pending).rejects.toMatchObject({
          name: "AgentSelectionRequiredError",
          code: "AGENT_SELECTION_REQUIRED",
          surface: "session agent resolution",
          hint: 'The agent-scoped session key belongs to "main", not "target".',
        });
      } else {
        expect((await pending)?.text).toContain(
          "elevated is not available right now (runtime=direct).",
        );
      }
    },
  );

  it.each([
    {
      rejectedRef: "ollama/Gemma4-26b-a4-it-gguf",
      reason: "disallowed" as const,
      expected:
        "Model override ollama/Gemma4-26b-a4-it-gguf is not allowed for this agent by modelPolicy.allow; reverted to openai/gpt-5.5. Add ollama/Gemma4-26b-a4-it-gguf to modelPolicy.allow or pick an allowed model with /model list.",
    },
    {
      rejectedRef: undefined,
      reason: "disallowed" as const,
      expected: "Model override not allowed for this agent; reverted to openai/gpt-5.5.",
    },
    {
      rejectedRef: "openai/gpt-4o",
      reason: "stale" as const,
      expected:
        "Stored model override openai/gpt-4o is stale for this session; reverted to openai/gpt-5.5. Pick a model again with /model if you still want to override the default.",
    },
  ])(
    "emits the $reason reset event before rejecting a locked mixed directive",
    async ({ rejectedRef, reason, expected }) => {
      const params = directiveParams("hello /model openai/gpt-5.4 --runtime openclaw");
      const { typing, sessionEntry, directives, modelState } = params;
      Object.assign(sessionEntry, {
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
        agentHarnessId: "codex",
        agentRuntimeOverride: "codex",
        modelSelectionLocked: true,
      });
      Object.assign(modelState, {
        resetModelOverride: true,
        resetModelOverrideRef: rejectedRef,
        resetModelOverrideReason: reason,
      });

      const originalEntry = { ...sessionEntry };
      const result = await applyInlineDirectiveOverrides({
        ...params,
        effectiveModelDirective: directives.rawModelDirective,
      });

      expectRejectedDirective(
        result,
        typing,
        { text: MODEL_SELECTION_LOCKED_MESSAGE, isError: true },
        "model-selection-locked",
      );
      expect(mocks.handleDirective).not.toHaveBeenCalled();
      expect(mocks.applyModelSelection).not.toHaveBeenCalled();
      expect(mocks.systemEvent).toHaveBeenCalledWith(expected, {
        sessionKey: "agent:main:main",
        contextKey: "model:reset:openai/gpt-5.5",
      });
      expect(sessionEntry).toEqual(originalEntry);
    },
  );

  it("stops a mixed inline turn when its transaction rejects unsupported thinking", async () => {
    const errorText =
      'Thinking level "ultra" is not supported for openai/gpt-5.6-luna. Use one of: off, low, medium, high, max.';
    mocks.handleDirective.mockImplementation(async (params) => {
      if (!params.persistenceState) {
        throw new Error("Expected a mixed-message transaction");
      }
      params.persistenceState.outcome = { kind: "rejected", errorText };
      params.onRejection?.();
      return { text: errorText };
    });
    const typing = createMockTypingController();
    const result = await applyInlineDirectiveOverrides(
      directiveParams("/think ultra please solve", {
        model: "gpt-5.6-luna",
        contextTokens: 372_000,
        typing,
      }),
    );

    expectRejectedDirective(result, typing, { text: errorText, isError: true });
    expect(mocks.handleDirective).toHaveBeenCalledOnce();
  });

  it("rejects unexpected native model arguments before model selection", async () => {
    const body = "/model openai/gpt-5.5 extra";
    const directives = parseInlineSessionDirectives(body, {
      command: { kind: "native", name: "model" },
    });
    const { result, typing } = await applyMixedDirectives({
      body,
      directives,
      provider: "openai",
      model: "gpt-5.5",
      senderIsOwner: true,
      allowedModels: [{ provider: "openai", id: "gpt-5.5", name: "GPT-5.5" }],
    });

    expectRejectedDirective(result, typing, { text: 'Unexpected argument "extra" for /model.' });
    expect(mocks.applyModelSelection).not.toHaveBeenCalled();
    expect(mocks.handleDirective).not.toHaveBeenCalled();
  });
});
