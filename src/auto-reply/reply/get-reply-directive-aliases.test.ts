import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSubscribedSessionHarness } from "../../agents/embedded-agent-subscribe.e2e-harness.js";
import {
  createOpenAiResponsesPartial,
  createOpenAiResponsesTextEvent,
} from "../../agents/embedded-agent-subscribe.openai-responses.test-helpers.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import type { ModelDefinitionConfig, OpenClawConfig } from "../../config/config.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import * as activeThinkingPolicy from "../../plugins/provider-thinking-active.js";
import { prepareModelCatalogThinkingPolicies } from "../../plugins/provider-thinking.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { FinalizedTemplateContext as TemplateContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import { createSessionEntry } from "./directive-handling.mixed-inline.test-helpers.js";
import { clearInlineDirectives } from "./get-reply-directives-utils.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
import {
  makeTypingController,
  replyDirectiveParams,
} from "./get-reply-directives.target-session.test-helpers.js";
import { withFastReplyConfig } from "./get-reply-fast-path.test-support.js";
import { createBlockReplyDeliveryHandler } from "./reply-delivery.js";
import { buildTestCtx } from "./test-ctx.js";
import { createTypingSignaler } from "./typing-mode.js";

const mocks = vi.hoisted(() => ({
  apply: vi.fn(),
  shouldHandle: vi.fn(),
  listForWorkspace: vi.fn(),
}));
const modelRef = { provider: "anthropic", model: "claude-opus-4-6" };

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

// mock-isolation: Observe parsed directive overrides without applying live session changes.
vi.mock("./get-reply-directives-apply.js", () => ({
  applyInlineDirectiveOverrides: (...args: unknown[]) => mocks.apply(...args),
}));
// mock-isolation: Control command eligibility independently of the directive parser under test.
vi.mock("../commands-text-routing.js", () => ({
  shouldHandleTextCommands: (...args: unknown[]) => mocks.shouldHandle(...args),
}));
// mock-isolation: Supply fixture skill commands without scanning the user's workspace.
vi.mock("../../skills/discovery/chat-commands.runtime.js", () => ({
  prepareSkillCommandsForWorkspace: (...args: unknown[]) => mocks.listForWorkspace(...args),
}));

type DirectiveApplyParams = Parameters<
  typeof import("./get-reply-directives-apply.js").applyInlineDirectiveOverrides
>[0];

function configWithModelAlias(alias: string, agentId?: string): OpenClawConfig {
  const models = { "anthropic/claude-opus-4-6": { alias } };
  return {
    commands: { text: true },
    agents: agentId ? { entries: { [agentId]: { models } } } : { defaults: { models } },
  };
}

function createAliasIndex(): ModelAliasIndex {
  const alias = { alias: "fable", ref: modelRef };
  return {
    byAlias: new Map([["fable", alias]]),
    byKey: new Map([["anthropic/claude-opus-4-6", ["fable"]]]),
  };
}

function continued(result: Awaited<ReturnType<typeof resolveReplyDirectives>>) {
  expect(result.kind).toBe("continue");
  if (result.kind !== "continue") {
    throw new Error(`expected continue result, got ${result.kind}`);
  }
  return result.result;
}

async function resolveModelDirective(params: {
  body: string;
  agentText?: string;
  authorized?: boolean;
  cfg?: OpenClawConfig;
  surface?: string;
  agentCfg?: Parameters<typeof resolveReplyDirectives>[0]["agentCfg"];
  opts?: Parameters<typeof resolveReplyDirectives>[0]["opts"];
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
  using ambientPolicy = vi
    .spyOn(activeThinkingPolicy, "resolveActiveProviderThinkingProfile")
    .mockImplementation(() => {
      throw new Error("Directive fixture attempted ambient model-policy discovery.");
    });
  const result = await withPluginMetadataSnapshotScope(
    directiveMetadata,
    () =>
      resolveReplyDirectives(
        replyDirectiveParams({
          ctx: buildTestCtx({
            Body: agentText,
            CommandBody: body,
            CommandAuthorized: authorized,
            Provider: surface,
            Surface: surface,
          }),
          cfg,
          agentCfg: params.agentCfg ?? {},
          opts: params.opts,
          sessionCtx,
          sessionEntry,
          sessionStore: { [sessionKey]: sessionEntry },
          sessionKey,
          storePath: undefined,
          triggerBodyNormalized: body,
          commandAuthorized: authorized,
          defaultProvider: "anthropic",
          defaultModel: "claude-opus-4-6",
          aliasIndex: createAliasIndex(),
          ...modelRef,
          preparedModelCatalog: preparedDirectiveCatalog,
        }),
      ),
    { config: cfg, trustConfigIdentity: true },
  );
  expect(ambientPolicy).not.toHaveBeenCalled();
  return { result, sessionEntry, sessionCtx };
}

describe("reply directive resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    mocks.shouldHandle.mockImplementation(
      (params: { cfg: OpenClawConfig }) => params.cfg.commands?.text !== false,
    );
    mocks.listForWorkspace.mockReturnValue([]);
    mocks.apply.mockImplementation(async (params: DirectiveApplyParams) => ({
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

  it.each([false, true])(
    "preserves media caption ownership with streaming=%s",
    async (streaming) => {
      const caption = streaming ? "Attachment caption" : "";
      const { result } = await resolveModelDirective({
        body: "Please send the attachment",
        agentCfg: streaming
          ? { blockStreamingDefault: "off", blockStreamingBreak: "text_end" }
          : {},
        opts: streaming ? { disableBlockStreaming: false } : undefined,
      });
      const resolved = continued(result);
      const onBlockReply = vi.fn<(payload: ReplyPayload) => void>();
      const onPartialReply = vi.fn();
      const handleBlockReply = createBlockReplyDeliveryHandler({
        onBlockReply,
        normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
        applyReplyToMode: (payload) => payload,
        typingSignals: createTypingSignaler({
          typing: makeTypingController(),
          mode: "never",
        }),
        blockStreamingEnabled: resolved.blockStreamingEnabled,
        blockReplyPipeline: null,
        directBlockDeliveries: [],
      });
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: "media-caption-directives",
        onBlockReply: handleBlockReply,
        onPartialReply,
        blockReplyBreak: resolved.resolvedBlockStreamingBreak,
      });
      const mediaUrl = "/tmp/attachment.txt";
      const text = `${caption}\nMEDIA:${mediaUrl}`.trimStart();
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
        expect(
          onBlockReply.mock.calls.map(([payload]) => ({
            text: payload.text ?? "",
            mediaUrl: payload.mediaUrl,
          })),
        ).toEqual(
          streaming
            ? [
                { text: caption, mediaUrl: undefined },
                { text: "", mediaUrl },
              ]
            : [{ text: caption, mediaUrl }],
        );
        if (caption) {
          expect(onPartialReply).toHaveBeenCalledWith(expect.objectContaining({ text: caption }));
        }
      } finally {
        subscription.unsubscribe();
      }
    },
  );

  it.each([
    {
      body: "/think high/fable now",
      cleaned: "now",
      expected: {
        hasThinkDirective: true,
        thinkLevel: "high",
        rawModelDirective: "fable",
      },
    },
    {
      body: "/localfast",
      cfg: configWithModelAlias("localfast", "main"),
      cleaned: "",
      expected: { rawModelDirective: "localfast" },
    },
  ])(
    "routes model aliases at the full reply boundary: $body",
    async ({ cleaned, expected, ...params }) => {
      const { result, sessionEntry, sessionCtx } = await resolveModelDirective(params);
      expect(continued(result)).toMatchObject({
        directives: { cleaned, hasModelDirective: true, ...expected },
        cleanedBody: cleaned,
      });
      expect(sessionCtx.Body).toBe(cleaned);
      expect(sessionEntry).toEqual(createSessionEntry());
    },
  );

  it("rejects invalid skill references before applying model directives", async () => {
    const skillCommands = Array.from({ length: 9 }, (_, index) => ({
      name: `skill_${index + 1}`,
      skillName: `skill-${index + 1}`,
      description: `Skill ${index + 1}`,
    }));
    const references = skillCommands.map((skill) => `$${skill.name}`).join(" ");
    const body = `${references} /model openai/gpt-5.6-luna`;
    mocks.listForWorkspace.mockReturnValue(skillCommands);

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
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(sessionEntry).toEqual(createSessionEntry());
  });

  it("still routes model directives after unknown skill references", async () => {
    const body = "Please use $missing_skill then /model anthropic/claude-opus-4-6";

    const { result } = await resolveModelDirective({
      body,
      cfg: { commands: { text: true } } as OpenClawConfig,
      surface: "webchat",
    });

    expect(continued(result)).toMatchObject({
      directives: { hasModelDirective: true, rawModelDirective: "anthropic/claude-opus-4-6" },
      cleanedBody: "Please use $missing_skill then",
    });
  });

  it.each([
    {
      label: "unauthorized mixed input",
      body: "please /model anthropic/claude-opus-4-6@work --runtime codex -s now",
      agentText: "[wrapped]\nplease /model anthropic/claude-opus-4-6 now",
      authorized: false,
    },
    {
      label: "commands.text:false with an empty agent projection",
      body: "please /fable --runtime codex -s now",
      agentText: "",
      cfg: { ...configWithModelAlias("fable"), commands: { text: false } },
      surface: "discord",
    },
  ])("keeps $label literal without exposing model state", async (params) => {
    const { body, agentText } = params;
    const { result, sessionEntry, sessionCtx } = await resolveModelDirective(params);
    const resolved = continued(result);
    expect(resolved.directives).toEqual(clearInlineDirectives(body));
    expect(resolved).toMatchObject({
      cleanedBody: agentText,
      ...modelRef,
    });
    expect(sessionCtx).toMatchObject({
      agentText,
      Body: agentText,
      BodyForAgent: agentText,
      BodyStripped: agentText,
    });
    expect(mocks.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        directives:
          params.authorized === false
            ? expect.objectContaining({ hasModelDirective: false })
            : clearInlineDirectives(body),
        ...modelRef,
      }),
    );
    expect(sessionEntry).toEqual(createSessionEntry());
  });
});
