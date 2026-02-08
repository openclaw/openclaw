import { describe, expect, it, vi } from "vitest";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { handleDirectiveOnly } from "./directive-handling.impl.js";
import { parseInlineDirectives } from "./directive-handling.js";
import {
  maybeHandleModelDirectiveInfo,
  resolveModelSelectionFromDirective,
} from "./directive-handling.model.js";

// Mock dependencies for directive handling persistence.
vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentConfig: vi.fn(() => ({})),
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
  resolveSessionAgentId: vi.fn(() => "main"),
}));

vi.mock("../../agents/sandbox.js", () => ({
  resolveSandboxRuntimeStatus: vi.fn(() => ({ sandboxed: false })),
}));

vi.mock("../../config/sessions.js", () => ({
  updateSessionStore: vi.fn(async () => {}),
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

function baseAliasIndex(): ModelAliasIndex {
  return { byAlias: new Map(), byKey: new Map() };
}

function baseConfig(): OpenClawConfig {
  return {
    commands: { text: true },
    agents: { defaults: {} },
  } as unknown as OpenClawConfig;
}

describe("/model chat UX", () => {
  it("shows fallback-only summary lines only when current model differs from default", async () => {
    const directives = parseInlineDirectives("/model");
    const cfg = { commands: { text: true } } as unknown as OpenClawConfig;
    const sharedSummaryLines = [
      "Switch: /model <provider/model>",
      "Browse: /models (providers) or /models <provider> (models)",
      "More: /model status",
    ];

    const nonFallbackReply = await maybeHandleModelDirectiveInfo({
      directives,
      cfg,
      agentDir: "/tmp/agent",
      activeAgentId: "main",
      provider: "anthropic",
      model: "claude-opus-4-5",
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
      aliasIndex: baseAliasIndex(),
      allowedModelCatalog: [],
      resetModelOverride: false,
    });

    const fallbackReply = await maybeHandleModelDirectiveInfo({
      directives,
      cfg,
      agentDir: "/tmp/agent",
      activeAgentId: "main",
      provider: "openai",
      model: "gpt-5.2",
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
      aliasIndex: baseAliasIndex(),
      allowedModelCatalog: [],
      resetModelOverride: false,
    });

    expect(nonFallbackReply?.text).toBe(
      ["Current: anthropic/claude-opus-4-5", "", ...sharedSummaryLines].join("\n"),
    );
    expect(nonFallbackReply?.text).not.toContain("Fallback active");
    expect(nonFallbackReply?.text).not.toContain("Default:");

    expect(fallbackReply?.text).toBe(
      [
        "Current: openai/gpt-5.2",
        "",
        "Fallback active",
        "Default: anthropic/claude-opus-4-5",
        "",
        ...sharedSummaryLines,
      ].join("\n"),
    );
  });

  it("keeps non-fallback /model summary wording unchanged", async () => {
    const directives = parseInlineDirectives("/model");
    const cfg = { commands: { text: true } } as unknown as OpenClawConfig;

    const reply = await maybeHandleModelDirectiveInfo({
      directives,
      cfg,
      agentDir: "/tmp/agent",
      activeAgentId: "main",
      provider: "anthropic",
      model: "claude-opus-4-5",
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
      aliasIndex: baseAliasIndex(),
      allowedModelCatalog: [],
      resetModelOverride: false,
    });

    expect(reply?.text).toBe(
      [
        "Current: anthropic/claude-opus-4-5",
        "",
        "Switch: /model <provider/model>",
        "Browse: /models (providers) or /models <provider> (models)",
        "More: /model status",
      ].join("\n"),
    );
    expect(reply?.text).not.toContain("Fallback active");
  });

  it("gates telegram fallback-only summary lines on current-vs-default mismatch", async () => {
    const directives = parseInlineDirectives("/model");
    const cfg = { commands: { text: true } } as unknown as OpenClawConfig;
    const telegramButtons = [[{ text: "Browse providers", callback_data: "mdl_prov" }]];

    const nonFallbackReply = await maybeHandleModelDirectiveInfo({
      directives,
      cfg,
      agentDir: "/tmp/agent",
      activeAgentId: "main",
      provider: "anthropic",
      model: "claude-opus-4-5",
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
      aliasIndex: baseAliasIndex(),
      allowedModelCatalog: [],
      resetModelOverride: false,
      surface: "telegram",
    });

    const fallbackReply = await maybeHandleModelDirectiveInfo({
      directives,
      cfg,
      agentDir: "/tmp/agent",
      activeAgentId: "main",
      provider: "openai",
      model: "gpt-5.2",
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
      aliasIndex: baseAliasIndex(),
      allowedModelCatalog: [],
      resetModelOverride: false,
      surface: "telegram",
    });

    expect(nonFallbackReply?.text).toBe(
      [
        "Current: anthropic/claude-opus-4-5",
        "",
        "Tap below to browse models, or use:",
        "/model <provider/model> to switch",
        "/model status for details",
      ].join("\n"),
    );
    expect(nonFallbackReply?.channelData).toEqual({ telegram: { buttons: telegramButtons } });
    expect(nonFallbackReply?.text).not.toContain("Fallback active");
    expect(nonFallbackReply?.text).not.toContain("Default:");

    expect(fallbackReply?.text).toBe(
      [
        "Current: openai/gpt-5.2",
        "",
        "Fallback active",
        "Default: anthropic/claude-opus-4-5",
        "",
        "Tap below to browse models, or use:",
        "/model <provider/model> to switch",
        "/model status for details",
      ].join("\n"),
    );
    expect(fallbackReply?.channelData).toEqual({ telegram: { buttons: telegramButtons } });
  });

  it("auto-applies closest match for typos", () => {
    const directives = parseInlineDirectives("/model anthropic/claud-opus-4-5");
    const cfg = { commands: { text: true } } as unknown as OpenClawConfig;

    const resolved = resolveModelSelectionFromDirective({
      directives,
      cfg,
      agentDir: "/tmp/agent",
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
      aliasIndex: baseAliasIndex(),
      allowedModelKeys: new Set(["anthropic/claude-opus-4-5"]),
      allowedModelCatalog: [{ provider: "anthropic", id: "claude-opus-4-5" }],
      provider: "anthropic",
    });

    expect(resolved.modelSelection).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-5",
      isDefault: true,
    });
    expect(resolved.errorText).toBeUndefined();
  });
});

describe("handleDirectiveOnly model persist behavior (fixes #1435)", () => {
  const allowedModelKeys = new Set(["anthropic/claude-opus-4-5", "openai/gpt-4o"]);
  const allowedModelCatalog = [
    { provider: "anthropic", id: "claude-opus-4-5" },
    { provider: "openai", id: "gpt-4o" },
  ];

  it("shows success message when session state is available", async () => {
    const directives = parseInlineDirectives("/model openai/gpt-4o");
    const sessionEntry: SessionEntry = {
      sessionId: "s1",
      updatedAt: Date.now(),
    };
    const sessionStore = { "agent:main:dm:1": sessionEntry };

    const result = await handleDirectiveOnly({
      cfg: baseConfig(),
      directives,
      sessionEntry,
      sessionStore,
      sessionKey: "agent:main:dm:1",
      storePath: "/tmp/sessions.json",
      elevatedEnabled: false,
      elevatedAllowed: false,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
      aliasIndex: baseAliasIndex(),
      allowedModelKeys,
      allowedModelCatalog,
      resetModelOverride: false,
      provider: "anthropic",
      model: "claude-opus-4-5",
      initialModelLabel: "anthropic/claude-opus-4-5",
      formatModelSwitchEvent: (label) => `Switched to ${label}`,
    });

    expect(result?.text).toContain("Model set to");
    expect(result?.text).toContain("openai/gpt-4o");
    expect(result?.text).not.toContain("failed");
  });

  it("shows no model message when no /model directive", async () => {
    const directives = parseInlineDirectives("hello world");
    const sessionEntry: SessionEntry = {
      sessionId: "s1",
      updatedAt: Date.now(),
    };
    const sessionStore = { "agent:main:dm:1": sessionEntry };

    const result = await handleDirectiveOnly({
      cfg: baseConfig(),
      directives,
      sessionEntry,
      sessionStore,
      sessionKey: "agent:main:dm:1",
      storePath: "/tmp/sessions.json",
      elevatedEnabled: false,
      elevatedAllowed: false,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
      aliasIndex: baseAliasIndex(),
      allowedModelKeys,
      allowedModelCatalog,
      resetModelOverride: false,
      provider: "anthropic",
      model: "claude-opus-4-5",
      initialModelLabel: "anthropic/claude-opus-4-5",
      formatModelSwitchEvent: (label) => `Switched to ${label}`,
    });

    expect(result?.text ?? "").not.toContain("Model set to");
    expect(result?.text ?? "").not.toContain("failed");
  });
});
