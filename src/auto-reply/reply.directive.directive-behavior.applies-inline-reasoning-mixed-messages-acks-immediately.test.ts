import { describe, expect, it } from "vitest";
import type { ModelAliasIndex } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { handleDirectiveOnly } from "./reply/directive-handling.impl.js";
import type { HandleDirectiveOnlyParams } from "./reply/directive-handling.params.js";
import { parseInlineDirectives } from "./reply/directive-handling.parse.js";
import { maybeHandleQueueDirective } from "./reply/directive-handling.queue-validation.js";

const emptyAliasIndex: ModelAliasIndex = {
  byAlias: new Map(),
  byKey: new Map(),
};

async function runDirectiveOnly(
  body: string,
  overrides: Partial<HandleDirectiveOnlyParams> = {},
): Promise<{ text?: string; sessionEntry: SessionEntry }> {
  const sessionKey = "agent:main:whatsapp:+1222";
  const sessionEntry: SessionEntry = {
    sessionId: "directive",
    updatedAt: Date.now(),
  };
  const result = await handleDirectiveOnly({
    cfg: {
      commands: { text: true },
      agents: {
        defaults: {
          model: "anthropic/claude-opus-4-6",
          workspace: "/tmp/openclaw",
        },
      },
    } as OpenClawConfig,
    directives: parseInlineDirectives(body),
    sessionEntry,
    sessionStore: { [sessionKey]: sessionEntry },
    sessionKey,
    elevatedEnabled: false,
    elevatedAllowed: false,
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-6",
    aliasIndex: emptyAliasIndex,
    allowedModelKeys: new Set(["anthropic/claude-opus-4-6"]),
    allowedModelCatalog: [],
    resetModelOverride: false,
    provider: "anthropic",
    model: "claude-opus-4-6",
    initialModelLabel: "anthropic/claude-opus-4-6",
    formatModelSwitchEvent: (label) => `Switched to ${label}`,
    ...overrides,
  });
  return { text: result?.text, sessionEntry };
}

describe("directive behavior", () => {
  it("handles standalone verbose directives and persistence", async () => {
    const enabled = await runDirectiveOnly("/verbose on");
    expect(enabled.text).toMatch(/^⚙️ Verbose logging enabled\./);
    expect(enabled.sessionEntry.verboseLevel).toBe("on");

    const disabled = await runDirectiveOnly("/verbose off");
    expect(disabled.text).toMatch(/Verbose logging disabled\./);
    expect(disabled.sessionEntry.verboseLevel).toBe("off");
  });
  it("covers think status", async () => {
    const { text } = await runDirectiveOnly("/think", {
      currentThinkLevel: "high",
    });
    expect(text).toContain("Current thinking level: high");
    expect(text).toContain("Options: off, minimal, low, medium, high, adaptive.");
  });
  it("reports invalid queue options and current queue settings", async () => {
    const invalid = maybeHandleQueueDirective({
      directives: parseInlineDirectives("/queue collect debounce:bogus cap:zero drop:maybe"),
      cfg: {} as OpenClawConfig,
      channel: "whatsapp",
    });
    expect(invalid?.text).toContain("Invalid debounce");
    expect(invalid?.text).toContain("Invalid cap");
    expect(invalid?.text).toContain("Invalid drop policy");

    const current = maybeHandleQueueDirective({
      directives: parseInlineDirectives("/queue"),
      cfg: {
        messages: {
          queue: {
            mode: "collect",
            debounceMs: 1500,
            cap: 9,
            drop: "summarize",
          },
        },
      } as OpenClawConfig,
      channel: "whatsapp",
    });
    expect(current?.text).toContain(
      "Current queue settings: mode=collect, debounce=1500ms, cap=9, drop=summarize.",
    );
    expect(current?.text).toContain(
      "Options: modes steer, followup, collect, steer+backlog, interrupt; debounce:<ms|s|m>, cap:<n>, drop:old|new|summarize.",
    );
  });
});
