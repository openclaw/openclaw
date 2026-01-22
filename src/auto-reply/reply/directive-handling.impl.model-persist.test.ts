import { describe, expect, it, vi } from "vitest";

import type { ModelAliasIndex } from "../../agents/model-selection.js";
import type { ClawdbotConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { parseInlineDirectives } from "./directive-handling.js";
import { handleDirectiveOnly } from "./directive-handling.impl.js";

// Mock dependencies
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

function baseConfig(): ClawdbotConfig {
  return {
    commands: { text: true },
    agents: { defaults: {} },
  } as unknown as ClawdbotConfig;
}

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

  it("shows error message when sessionEntry is missing", async () => {
    const directives = parseInlineDirectives("/model openai/gpt-4o");
    const sessionStore = {};

    const result = await handleDirectiveOnly({
      cfg: baseConfig(),
      directives,
      sessionEntry: undefined, // Missing!
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

    expect(result?.text).toContain("failed");
    expect(result?.text).toContain("session state unavailable");
  });

  it("shows error message when sessionStore is missing", async () => {
    const directives = parseInlineDirectives("/model openai/gpt-4o");
    const sessionEntry: SessionEntry = {
      sessionId: "s1",
      updatedAt: Date.now(),
    };

    const result = await handleDirectiveOnly({
      cfg: baseConfig(),
      directives,
      sessionEntry,
      sessionStore: undefined, // Missing!
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

    expect(result?.text).toContain("failed");
    expect(result?.text).toContain("session state unavailable");
  });

  it("shows error message when sessionKey is missing", async () => {
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
      sessionKey: undefined, // Missing!
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

    expect(result?.text).toContain("failed");
    expect(result?.text).toContain("session state unavailable");
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

    // No model directive = no model message
    expect(result?.text ?? "").not.toContain("Model set to");
    expect(result?.text ?? "").not.toContain("failed");
  });
});
