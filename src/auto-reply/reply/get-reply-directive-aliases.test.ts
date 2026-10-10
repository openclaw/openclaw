/** Tests configured directives through parser, reply-routing, and delivery boundaries. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSubscribedSessionHarness } from "../../agents/embedded-agent-subscribe.e2e-harness.js";
import {
  createOpenAiResponsesPartial,
  createOpenAiResponsesTextEvent,
} from "../../agents/embedded-agent-subscribe.openai-responses.test-helpers.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import type { ModelDefinitionConfig, OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import * as activeThinkingPolicy from "../../plugins/provider-thinking-active.js";
import { prepareModelCatalogThinkingPolicies } from "../../plugins/provider-thinking.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { FinalizedTemplateContext as TemplateContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import { clearInlineDirectives } from "./get-reply-directives-utils.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
import { withFastReplyConfig } from "./get-reply-fast-path.test-support.js";
import { prepareReplyConversation } from "./prompt-session-context.js";
import { createBlockReplyDeliveryHandler } from "./reply-delivery.js";
import { buildTestCtx } from "./test-ctx.js";
import { createTypingSignaler } from "./typing-mode.js";

const directiveApplyMocks = vi.hoisted(() => ({
  apply: vi.fn(),
}));
const textRoutingMocks = vi.hoisted(() => ({
  shouldHandle: vi.fn(),
}));
const skillCommandMocks = vi.hoisted(() => ({
  listForWorkspace: vi.fn(),
}));

const directiveModel: ModelDefinitionConfig = {
  id: "claude-opus-4-6",
  name: "Directive fixture",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
};
const directiveCatalog = [{ provider: "anthropic", ...directiveModel }];
const directiveMetadata = createPluginMetadataSnapshotFixture();
const preparedDirectiveCatalog: ModelCatalogSnapshot = {
  entries: directiveCatalog,
  routeVariants: directiveCatalog,
};
prepareModelCatalogThinkingPolicies({
  catalog: preparedDirectiveCatalog,
  metadataSnapshot: directiveMetadata,
  pluginRegistry: {
    ...createEmptyPluginRegistry(),
    providers: [
      {
        pluginId: "anthropic",
        source: "test",
        provider: {
          id: "anthropic",
          label: "Anthropic",
          auth: [],
          resolveThinkingProfile: () => undefined,
        },
      },
    ],
  },
});

vi.mock("./get-reply-directives-apply.js", () => ({
  applyInlineDirectiveOverrides: (...args: unknown[]) => directiveApplyMocks.apply(...args),
}));
vi.mock("../commands-text-routing.js", () => ({
  shouldHandleTextCommands: (...args: unknown[]) => textRoutingMocks.shouldHandle(...args),
}));
vi.mock("../../skills/discovery/chat-commands.runtime.js", () => ({
  prepareSkillCommandsForWorkspace: (...args: unknown[]) =>
    skillCommandMocks.listForWorkspace(...args),
}));

type DirectiveApplyParams = Parameters<
  typeof import("./get-reply-directives-apply.js").applyInlineDirectiveOverrides
>[0];

function configWithModelAlias(alias: string): OpenClawConfig {
  return {
    commands: { text: true },
    agents: {
      defaults: {
        models: {
          "anthropic/claude-opus-4-6": { alias },
        },
      },
    },
  } as unknown as OpenClawConfig;
}

function createAliasIndex(): ModelAliasIndex {
  return {
    byAlias: new Map([
      [
        "fable",
        {
          alias: "fable",
          ref: { provider: "anthropic", model: "claude-opus-4-6" },
        },
      ],
    ]),
    byKey: new Map([["anthropic/claude-opus-4-6", ["fable"]]]),
  };
}

function createSessionEntry(): SessionEntry {
  return { sessionId: "session-1", updatedAt: 1 };
}

function makeTypingController() {
  return {
    onReplyStart: async () => {},
    startTypingLoop: async () => {},
    startTypingOnText: async () => {},
    refreshTypingTtl: () => {},
    isActive: () => false,
    markRunComplete: () => {},
    markDispatchIdle: () => {},
    cleanup: vi.fn(),
  };
}

async function resolveModelDirective(params: {
  body: string;
  agentText?: string;
  authorized?: boolean;
  cfg?: OpenClawConfig;
  surface?: string;
  agentCfg?: Parameters<typeof resolveReplyDirectives>[0]["agentCfg"];
  opts?: Parameters<typeof resolveReplyDirectives>[0]["opts"];
  preparedModelCatalog?: ModelCatalogSnapshot;
}) {
  const authorized = params.authorized ?? true;
  const { body } = params;
  const agentText = params.agentText ?? body;
  const surface = params.surface ?? "whatsapp";
  const sessionKey = "agent:main:whatsapp:+2000";
  const sessionEntry = createSessionEntry();
  const sessionCtx = {
    Body: agentText,
    BodyStripped: agentText,
    BodyForAgent: agentText,
    CommandBody: body,
    commandText: body,
    agentText,
    rawText: body,
    Provider: surface,
    Surface: surface,
  } as TemplateContext;
  const cfg = withFastReplyConfig({
    ...(params.cfg ?? configWithModelAlias("fable")),
    models: params.cfg?.models ?? {
      providers: {
        anthropic: { baseUrl: "https://directive.invalid", models: [directiveModel] },
      },
    },
  });
  const ambientPolicy = vi
    .spyOn(activeThinkingPolicy, "resolveActiveProviderThinkingProfile")
    .mockImplementation(() => {
      throw new Error("Directive fixture attempted ambient model-policy discovery.");
    });
  try {
    const result = await withPluginMetadataSnapshotScope(
      directiveMetadata,
      () =>
        resolveReplyDirectives({
          ctx: buildTestCtx({
            Body: agentText,
            CommandBody: body,
            CommandAuthorized: authorized,
            Provider: surface,
            Surface: surface,
          }),
          cfg,
          agentId: "main",
          agentDir: "/tmp/main-agent",
          workspaceDir: "/tmp",
          agentCfg: params.agentCfg ?? {},
          opts: params.opts,
          sessionCtx,
          sessionEntry,
          sessionStore: { [sessionKey]: sessionEntry },
          sessionKey,
          sessionScope: "per-sender",
          conversation: prepareReplyConversation({ ctx: sessionCtx, sessionEntry }),
          isGroup: false,
          triggerBodyNormalized: body,
          resetTriggered: false,
          commandAuthorized: authorized,
          defaultProvider: "anthropic",
          defaultModel: "claude-opus-4-6",
          aliasIndex: createAliasIndex(),
          provider: "anthropic",
          model: "claude-opus-4-6",
          hasResolvedHeartbeatModelOverride: false,
          preparedModelCatalog: params.preparedModelCatalog ?? preparedDirectiveCatalog,
          typing: makeTypingController(),
        }),
      { config: cfg, trustConfigIdentity: true },
    );
    return { result, sessionEntry, sessionCtx };
  } finally {
    ambientPolicy.mockRestore();
  }
}

describe("reply directive resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    textRoutingMocks.shouldHandle.mockImplementation(
      (params: { cfg: OpenClawConfig }) => params.cfg.commands?.text !== false,
    );
    skillCommandMocks.listForWorkspace.mockReturnValue([]);
    directiveApplyMocks.apply.mockImplementation(async (params: DirectiveApplyParams) => ({
      kind: "continue",
      directives: params.directives,
      provider: params.provider,
      model: params.model,
      contextTokens: params.contextTokens,
    }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses prepared thinking defaults for an unrestricted ordinary reply", async () => {
    const model = { ...directiveModel, reasoning: true };
    const preparedModelCatalog: ModelCatalogSnapshot = {
      entries: [{ provider: "anthropic", ...model }],
      routeVariants: [],
    };
    prepareModelCatalogThinkingPolicies({
      catalog: preparedModelCatalog,
      metadataSnapshot: directiveMetadata,
      pluginRegistry: {
        ...createEmptyPluginRegistry(),
        providers: [
          {
            pluginId: "anthropic",
            source: "test",
            provider: {
              id: "anthropic",
              label: "Anthropic",
              auth: [],
              resolveThinkingProfile: () => ({
                levels: [{ id: "off" }, { id: "high" }],
                defaultLevel: "high",
              }),
            },
          },
        ],
      },
    });
    const { result } = await resolveModelDirective({
      body: "Summarize the notes.",
      cfg: {
        models: {
          providers: {
            anthropic: { baseUrl: "https://directive.invalid", models: [model] },
          },
        },
      },
      preparedModelCatalog,
    });
    if (result.kind !== "continue") {
      throw new Error(`expected continue result, got ${result.kind}`);
    }
    await expect(result.result.resolveModelLevels()).resolves.toMatchObject({
      resolvedThinkLevel: "high",
    });
  });

  it.each([{ body: "Please read /fable/notes.md before replying", skipInventory: false }])(
    "preserves ordinary slash text: $body",
    async ({ body, skipInventory }) => {
      skillCommandMocks.listForWorkspace.mockReturnValue([
        { name: "fable", skillName: "fable", description: "A colliding skill command" },
      ]);

      const { result, sessionEntry, sessionCtx } = await resolveModelDirective({ body });

      if (result.kind !== "continue") {
        throw new Error(`expected continue result, got ${result.kind}`);
      }
      expect(result.result.directives).toEqual(clearInlineDirectives(body));
      expect(result.result.cleanedBody).toBe(body);
      expect(sessionCtx).toMatchObject({
        agentText: body,
        Body: body,
        BodyForAgent: body,
        BodyStripped: body,
      });
      expect(result.result.provider).toBe("anthropic");
      expect(result.result.model).toBe("claude-opus-4-6");
      expect(sessionEntry).toEqual(createSessionEntry());
      if (skipInventory) {
        expect(skillCommandMocks.listForWorkspace).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    {
      label: "per-turn disabled despite configured on",
      agentCfg: { blockStreamingDefault: "on", blockStreamingBreak: "text_end" },
      opts: { disableBlockStreaming: true },
      caption: "Attachment caption",
    },
    { label: "captionless default off", agentCfg: {}, caption: "" },
    {
      label: "per-turn enabled despite configured off",
      agentCfg: { blockStreamingDefault: "off", blockStreamingBreak: "text_end" },
      opts: { disableBlockStreaming: false },
      caption: "Attachment caption",
      separateCaption: true,
    },
  ] satisfies Array<{
    label: string;
    agentCfg: Parameters<typeof resolveReplyDirectives>[0]["agentCfg"];
    opts?: Parameters<typeof resolveReplyDirectives>[0]["opts"];
    caption: string;
    separateCaption?: boolean;
  }>)("preserves media caption ownership with $label", async (testCase) => {
    const { result } = await resolveModelDirective({
      body: "Please send the attachment",
      agentCfg: testCase.agentCfg,
      opts: "opts" in testCase ? testCase.opts : undefined,
    });
    if (result.kind !== "continue") {
      throw new Error(`expected continue result, got ${result.kind}`);
    }
    const delivered: ReplyPayload[] = [];
    const onPartialReply = vi.fn();
    const handleBlockReply = createBlockReplyDeliveryHandler({
      onBlockReply: (payload) => {
        delivered.push(payload);
      },
      normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
      applyReplyToMode: (payload) => payload,
      typingSignals: createTypingSignaler({
        typing: makeTypingController(),
        mode: "never",
        isHeartbeat: false,
      }),
      blockStreamingEnabled: result.result.blockStreamingEnabled,
      blockReplyPipeline: null,
      directBlockDeliveries: [],
    });
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "media-caption-directives",
      onBlockReply: handleBlockReply,
      onPartialReply,
      blockReplyBreak: result.result.resolvedBlockStreamingBreak,
    });
    const mediaUrl = "/tmp/attachment.txt";
    const text = `${testCase.caption}\nMEDIA:${mediaUrl}`.trimStart();
    const message = createOpenAiResponsesPartial({
      text,
      id: "media-caption",
      signaturePhase: "final_answer",
      partialPhase: "final_answer",
    });
    try {
      emit({ type: "message_start", message });
      for (const type of ["text_delta", "text_end"] as const) {
        emit(
          createOpenAiResponsesTextEvent({
            type,
            text,
            partial: message,
            messagePhase: "final_answer",
          }),
        );
        await subscription.waitForPendingEvents();
      }
      emit({ type: "message_end", message });
      await subscription.waitForPendingEvents();
      const separateCaption = "separateCaption" in testCase && testCase.separateCaption;
      expect(
        delivered.map((payload) => ({ text: payload.text ?? "", mediaUrl: payload.mediaUrl })),
      ).toEqual(
        separateCaption
          ? [
              { text: testCase.caption, mediaUrl: undefined },
              { text: "", mediaUrl },
            ]
          : [{ text: testCase.caption, mediaUrl }],
      );
      if (testCase.caption) {
        expect(onPartialReply).toHaveBeenCalledWith(
          expect.objectContaining({ text: testCase.caption }),
        );
      }
    } finally {
      subscription.unsubscribe();
    }
  });

  it.each([
    {
      body: "/fable -s",
      expected: {
        cleaned: "",
        hasModelDirective: true,
        rawModelDirective: "fable",
        modelScope: "session",
      },
    },
    {
      body: "/think high/fable now",
      expected: {
        cleaned: "now",
        hasThinkDirective: true,
        thinkLevel: "high",
        hasModelDirective: true,
        rawModelDirective: "fable",
      },
    },
  ])("routes model scope at the full reply boundary: $body", async ({ body, expected }) => {
    const { result, sessionEntry, sessionCtx } = await resolveModelDirective({ body });

    expect(result.kind).toBe("continue");
    if (result.kind !== "continue") {
      throw new Error(`expected continue result, got ${result.kind}`);
    }
    expect(result.result.directives).toMatchObject(expected);
    expect(result.result.cleanedBody).toBe(expected.cleaned);
    expect(sessionCtx.Body).toBe(expected.cleaned);
    expect(sessionEntry).toEqual(createSessionEntry());
  });

  it("preserves unauthorized mixed input exactly without exposing model state", async () => {
    const body = "please /model anthropic/claude-opus-4-6@work --runtime codex -s now";
    const agentText = "[wrapped]\nplease /model anthropic/claude-opus-4-6 now";
    const { result, sessionEntry, sessionCtx } = await resolveModelDirective({
      body,
      agentText,
      authorized: false,
    });

    expect(result.kind).toBe("continue");
    if (result.kind !== "continue") {
      throw new Error(`expected continue result, got ${result.kind}`);
    }
    expect(result.result.directives).toEqual(clearInlineDirectives(body));
    expect(result.result.cleanedBody).toBe(agentText);
    expect(sessionCtx).toMatchObject({
      agentText,
      Body: agentText,
      BodyForAgent: agentText,
      BodyStripped: agentText,
    });
    expect(result.result.provider).toBe("anthropic");
    expect(result.result.model).toBe("claude-opus-4-6");
    expect(directiveApplyMocks.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        directives: expect.objectContaining({ hasModelDirective: false }),
        provider: "anthropic",
        model: "claude-opus-4-6",
      }),
    );
    expect(sessionEntry).toEqual(createSessionEntry());
  });

  it("rejects invalid skill references before applying model directives", async () => {
    const skillCommands = Array.from({ length: 9 }, (_, index) => ({
      name: `skill_${index + 1}`,
      skillName: `skill-${index + 1}`,
      description: `Skill ${index + 1}`,
    }));
    const references = skillCommands.map((skill) => `$${skill.name}`).join(" ");
    const body = `${references} /model openai/gpt-5.6-luna`;
    skillCommandMocks.listForWorkspace.mockReturnValue(skillCommands);

    const { result, sessionEntry } = await resolveModelDirective({
      body,
      cfg: { commands: { text: true } } as OpenClawConfig,
      surface: "webchat",
    });

    expect(result).toEqual({
      kind: "reply",
      reply: {
        text: "Too many skill references. Use at most 8 skills in one message.",
      },
    });
    expect(directiveApplyMocks.apply).not.toHaveBeenCalled();
    expect(sessionEntry).toEqual(createSessionEntry());
  });

  it("still routes model directives after unknown skill references", async () => {
    const body = "Please use $missing_skill then /model anthropic/claude-opus-4-6";

    const { result } = await resolveModelDirective({
      body,
      cfg: { commands: { text: true } } as OpenClawConfig,
      surface: "webchat",
    });

    expect(result.kind).toBe("continue");
    if (result.kind !== "continue") {
      throw new Error(`expected continue result, got ${result.kind}`);
    }
    expect(result.result.directives).toMatchObject({
      hasModelDirective: true,
      rawModelDirective: "anthropic/claude-opus-4-6",
    });
    expect(result.result.cleanedBody).toBe("Please use $missing_skill then");
  });

  it("keeps commands.text:false model syntax literal, including an empty agent projection", async () => {
    const body = "please /fable --runtime codex -s now";
    const { result, sessionEntry, sessionCtx } = await resolveModelDirective({
      body,
      agentText: "",
      cfg: {
        ...configWithModelAlias("fable"),
        commands: { text: false },
      } as OpenClawConfig,
      surface: "discord",
    });

    expect(result.kind).toBe("continue");
    if (result.kind !== "continue") {
      throw new Error(`expected continue result, got ${result.kind}`);
    }
    expect(result.result.directives).toEqual(clearInlineDirectives(body));
    expect(result.result.cleanedBody).toBe("");
    expect(sessionCtx).toMatchObject({
      agentText: "",
      Body: "",
      BodyForAgent: "",
      BodyStripped: "",
    });
    expect(directiveApplyMocks.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        directives: clearInlineDirectives(body),
        provider: "anthropic",
        model: "claude-opus-4-6",
      }),
    );
    expect(sessionEntry).toEqual(createSessionEntry());
  });
});
