import "./reply.directive.directive-behavior.e2e-mocks.js";
import { describe, expect, it } from "vitest";
import type { ModelAliasIndex } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  installDirectiveBehaviorE2EHooks,
  makeWhatsAppDirectiveConfig,
  replyText,
  sessionStorePath,
  withTempHome,
} from "./reply.directive.directive-behavior.e2e-harness.js";
import { runEmbeddedPiAgentMock } from "./reply.directive.directive-behavior.e2e-mocks.js";
import { getReplyFromConfig } from "./reply.js";
import { handleDirectiveOnly } from "./reply/directive-handling.impl.js";
import type { HandleDirectiveOnlyParams } from "./reply/directive-handling.params.js";
import { parseInlineDirectives } from "./reply/directive-handling.parse.js";

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
  installDirectiveBehaviorE2EHooks();

  it("handles standalone verbose directives and persistence", async () => {
    const enabled = await runDirectiveOnly("/verbose on");
    expect(enabled.text).toMatch(/^⚙️ Verbose logging enabled\./);
    expect(enabled.sessionEntry.verboseLevel).toBe("on");

    const disabled = await runDirectiveOnly("/verbose off");
    expect(disabled.text).toMatch(/Verbose logging disabled\./);
    expect(disabled.sessionEntry.verboseLevel).toBe("off");
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  });
  it("covers think status", async () => {
    const { text } = await runDirectiveOnly("/think", {
      currentThinkLevel: "high",
    });
    expect(text).toContain("Current thinking level: high");
    expect(text).toContain("Options: off, minimal, low, medium, high, adaptive.");
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  });
  it("keeps reserved command aliases from matching after trimming", async () => {
    await withTempHome(async (home) => {
      const res = await getReplyFromConfig(
        {
          Body: "/help",
          From: "+1222",
          To: "+1222",
          CommandAuthorized: true,
        },
        {},
        makeWhatsAppDirectiveConfig(
          home,
          {
            model: "anthropic/claude-opus-4-6",
            models: {
              "anthropic/claude-opus-4-6": { alias: " help " },
            },
          },
          { session: { store: sessionStorePath(home) } },
        ),
      );

      const text = replyText(res);
      expect(text).toContain("Help");
      expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    });
  });
  it("reports invalid queue options and current queue settings", async () => {
    await withTempHome(async (home) => {
      const invalidRes = await getReplyFromConfig(
        {
          Body: "/queue collect debounce:bogus cap:zero drop:maybe",
          From: "+1222",
          To: "+1222",
          CommandAuthorized: true,
        },
        {},
        makeWhatsAppDirectiveConfig(
          home,
          { model: "anthropic/claude-opus-4-6" },
          {
            session: { store: sessionStorePath(home) },
          },
        ),
      );

      const invalidText = replyText(invalidRes);
      expect(invalidText).toContain("Invalid debounce");
      expect(invalidText).toContain("Invalid cap");
      expect(invalidText).toContain("Invalid drop policy");

      const currentRes = await getReplyFromConfig(
        {
          Body: "/queue",
          From: "+1222",
          To: "+1222",
          Provider: "whatsapp",
          CommandAuthorized: true,
        },
        {},
        makeWhatsAppDirectiveConfig(
          home,
          { model: "anthropic/claude-opus-4-6" },
          {
            messages: {
              queue: {
                mode: "collect",
                debounceMs: 1500,
                cap: 9,
                drop: "summarize",
              },
            },
            session: { store: sessionStorePath(home) },
          },
        ),
      );

      const text = replyText(currentRes);
      expect(text).toContain(
        "Current queue settings: mode=collect, debounce=1500ms, cap=9, drop=summarize.",
      );
      expect(text).toContain(
        "Options: modes steer, followup, collect, steer+backlog, interrupt; debounce:<ms|s|m>, cap:<n>, drop:old|new|summarize.",
      );
      expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    });
  });
});
