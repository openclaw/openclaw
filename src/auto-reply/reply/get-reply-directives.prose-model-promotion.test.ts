/** End-to-end promotion of prose model candidates through resolveReplyDirectives (#137197). */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import {
  applyMixedDirectives,
  createSessionEntry,
} from "./directive-handling.mixed-inline.test-helpers.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
import {
  makeSessionEntry,
  makeTypingController,
} from "./get-reply-directives.target-session.test-helpers.js";
import { prepareReplyConversation } from "./prompt-session-context.js";
import { buildTestCtx } from "./test-ctx.js";

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

// Thinking-catalog lookups must not trigger real provider discovery in these tests.
vi.mock("../../agents/model-catalog.runtime.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  loadManifestModelCatalog: vi.fn(() => []),
  loadPreparedModelCatalogSnapshot: vi.fn(async () => ({
    entries: [],
    routeVariants: [],
    authoritative: true,
  })),
}));

vi.mock("../../agents/sticky-model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/sticky-model-selection.js")>()),
  persistStickyModelSelectionBestEffort: vi.fn(),
}));

vi.mock("../../gateway/session-patch-hooks.js", () => ({
  triggerSessionPatchHook: vi.fn(),
}));

vi.mock("./session-entry-persistence.js", () => ({
  persistReplySessionEntry: vi.fn(async ({ entry }: { entry: SessionEntry }) => ({
    status: "current" as const,
    entry: { ...entry },
  })),
}));

const emptyAliasIndex: ModelAliasIndex = { byAlias: new Map(), byKey: new Map() };

function makeCfg(model: string): OpenClawConfig {
  return {
    commands: { text: true },
    agents: { defaults: { model } },
  } as OpenClawConfig;
}

const catalog = (
  entries: Array<{ provider: string; id: string; name: string }>,
): ModelCatalogSnapshot => ({
  entries,
  routeVariants: entries,
  authoritative: true,
});

async function runDirectives(params: {
  body: string;
  cfg: OpenClawConfig;
  defaultProvider: string;
  defaultModel: string;
  preparedModelCatalog: ModelCatalogSnapshot;
  /** Overrides the sender-command text the routing layer sees, distinct from the full body. */
  commandText?: string;
  /** Channel-identified sender span (`ChannelContext.chat.commandSourceText`). */
  commandSourceText?: string;
}) {
  const sessionEntry = makeSessionEntry();
  const sessionKey = "agent:main:whatsapp:+2000";
  const sessionStore = { [sessionKey]: sessionEntry };
  const sessionCtx = {
    Body: params.body,
    BodyStripped: params.body,
    BodyForAgent: params.body,
    CommandBody: params.body,
    commandText: params.commandText ?? params.body,
    agentText: params.body,
    rawText: params.body,
    Provider: "whatsapp",
  } as Parameters<typeof resolveReplyDirectives>[0]["sessionCtx"];
  const channelContext = params.commandSourceText
    ? { chat: { commandSourceText: params.commandSourceText } }
    : undefined;
  const result = await resolveReplyDirectives({
    ctx: buildTestCtx({
      Body: params.body,
      CommandBody: params.body,
      CommandAuthorized: true,
      ...(channelContext ? { ChannelContext: channelContext } : {}),
      ...(params.commandText ? { rawText: params.body } : {}),
    }),
    cfg: params.cfg,
    agentId: "main",
    agentDir: "/tmp/main-agent",
    workspaceDir: "/tmp",
    agentCfg: params.cfg.agents?.defaults ?? {},
    sessionCtx,
    sessionEntry,
    sessionStore,
    sessionKey,
    sessionScope: "per-sender",
    conversation: prepareReplyConversation({
      ctx: buildTestCtx({
        Body: params.body,
        CommandBody: params.body,
        CommandAuthorized: true,
        ...(channelContext ? { ChannelContext: channelContext } : {}),
        ...(params.commandText ? { rawText: params.body } : {}),
      }),
      sessionEntry,
    }),
    isGroup: false,
    triggerBodyNormalized: params.body,
    resetTriggered: false,
    commandAuthorized: true,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
    provider: params.defaultProvider,
    model: params.defaultModel,
    aliasIndex: emptyAliasIndex,
    hasResolvedHeartbeatModelOverride: false,
    typing: makeTypingController(),
    preparedModelCatalog: params.preparedModelCatalog,
  });
  return { result, sessionCtx, sessionEntry: sessionStore[sessionKey] as SessionEntry };
}

describe("prose model candidate promotion through reply directives", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("promotes a cataloged bare token and strips the span from the agent prompt", async () => {
    const body = "please reply /model gpt-4o continue";
    const { result, sessionCtx, sessionEntry } = await runDirectives({
      body,
      cfg: makeCfg("anthropic/claude-opus-4-6"),
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
      preparedModelCatalog: catalog([
        { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6" },
        { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
      ]),
    });

    expect(result.kind).toBe("continue");
    if (result.kind !== "continue") {
      throw new Error("expected the promoted candidate to continue the turn");
    }
    // Catalog-backed resolution names the openai route, not the default-provider construction.
    expect(result.result.provider).toBe("openai");
    expect(result.result.model).toBe("gpt-4o");
    expect(result.result.requestedRouteResolution).toBe("resolved");
    expect(result.result.directiveAck?.text).toContain("openai/gpt-4o");
    // The accepted directive span leaves the routed prompt text exactly as a
    // parse-time acceptance would have; supplemental words survive.
    expect(result.result.cleanedBody).toBe("please reply continue");
    expect(sessionCtx.agentText).toBe("please reply continue");
    expect(sessionCtx.BodyForAgent).toBe("please reply continue");
    expect(sessionCtx.BodyStripped).toBe("please reply continue");
    expect(sessionEntry.modelOverride).toBe("gpt-4o");
  });

  it("keeps synthetic tokens as prose and leaves the prompt untouched", async () => {
    const body = "please reply /model gpt-9-imaginary continue";
    const { result, sessionCtx, sessionEntry } = await runDirectives({
      body,
      cfg: makeCfg("anthropic/claude-opus-4-6"),
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
      preparedModelCatalog: catalog([
        { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6" },
      ]),
    });

    expect(result).toMatchObject({
      kind: "continue",
      result: {
        provider: "anthropic",
        model: "claude-opus-4-6",
        directives: { hasModelDirective: false },
      },
    });
    expect(result.kind === "continue" && result.result.directiveAck).toBeUndefined();
    // The mention stays ordinary text for the model.
    expect(sessionCtx.agentText).toBe(body);
    expect(result.kind === "continue" && result.result.cleanedBody).toBe(body);
    expect(sessionEntry.modelOverride).toBeUndefined();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("keeps synthetic bare tokens as prose at the apply layer with no picker keys", async () => {
    // No picker keys and no aliases: the resolver's permitted fallback would
    // construct a default-provider selection for this token, which must not
    // promote into a session-wide model switch.
    const body = "please reply /model totally-fake-model continue";
    const { result, sessionEntry } = await applyMixedDirectives({
      body,
      cfg: { commands: { text: true }, agents: { defaults: {} } } as OpenClawConfig,
    });

    expect(result).toMatchObject({
      kind: "continue",
      provider: "anthropic",
      model: "claude-opus-4-6",
      directives: { hasModelDirective: false },
    });
    expect(result).not.toHaveProperty("directiveAck");
    expect(sessionEntry).toEqual(createSessionEntry());
  });

  it("strips the sender's promoted span from an opaque body without touching earlier history", async () => {
    // Quoted history mentions the same token before the sender block; the body
    // is non-leading, so routing keeps it opaque. Promotion must remove the
    // sender's own verified span, never the first matching occurrence in the
    // model-facing prompt (#137197).
    const senderText = "please switch /model gpt-4o now";
    const body = `earlier quoted /model gpt-4o line\n${senderText}`;
    const { result, sessionCtx, sessionEntry } = await runDirectives({
      body,
      cfg: makeCfg("anthropic/claude-opus-4-6"),
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
      preparedModelCatalog: catalog([
        { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6" },
        { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
      ]),
      commandText: senderText,
      commandSourceText: senderText,
    });

    expect(result.kind).toBe("continue");
    if (result.kind !== "continue") {
      throw new Error("expected the promoted candidate to continue the turn");
    }
    expect(result.result.provider).toBe("openai");
    expect(result.result.model).toBe("gpt-4o");
    // The quoted history line keeps its token; only the sender's span leaves.
    const projected = "earlier quoted /model gpt-4o line\nplease switch now";
    expect(result.result.cleanedBody).toBe(projected);
    expect(sessionCtx.agentText).toBe(projected);
    expect(sessionCtx.BodyForAgent).toBe(projected);
    expect(sessionCtx.BodyStripped).toBe(projected);
    expect(sessionEntry.modelOverride).toBe("gpt-4o");
  });
});
