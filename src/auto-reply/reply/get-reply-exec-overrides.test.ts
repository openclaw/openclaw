import { describe, expect, it } from "vitest";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { parseInlineDirectives } from "./directive-handling.parse.js";
import { persistInlineDirectives } from "./directive-handling.persist.js";
import { type ReplyExecOverrides, resolveReplyExecOverrides } from "./get-reply-exec-overrides.js";

const AGENT_EXEC_DEFAULTS = {
  host: "node",
  security: "allowlist",
  ask: "always",
  node: "worker-alpha",
} as const satisfies ReplyExecOverrides;

function createSessionEntry(overrides?: Partial<SessionEntry>): SessionEntry {
  return {
    sessionId: "main",
    updatedAt: Date.now(),
    ...overrides,
  };
}

async function persistExecDirective(params: {
  sessionEntry: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  body: string;
}) {
  await persistInlineDirectives({
    directives: parseInlineDirectives(params.body),
    cfg: { commands: { text: true } } as OpenClawConfig,
    agentDir: "/tmp/agent",
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
    sessionKey: "agent:main:main",
    elevatedEnabled: false,
    elevatedAllowed: false,
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-6",
    aliasIndex: { byAlias: new Map(), byKey: new Map() } satisfies ModelAliasIndex,
    allowedModelKeys: new Set(),
    provider: "anthropic",
    model: "claude-opus-4-6",
    initialModelLabel: "anthropic/claude-opus-4-6",
    formatModelSwitchEvent: (label) => label,
    agentCfg: undefined,
    surface: "whatsapp",
  });
}

describe("reply exec overrides", () => {
  it("uses per-agent exec defaults when session and message are unset", () => {
    expect(
      resolveReplyExecOverrides({
        directives: parseInlineDirectives("run a command"),
        sessionEntry: createSessionEntry(),
        agentExecDefaults: AGENT_EXEC_DEFAULTS,
      }),
    ).toEqual(AGENT_EXEC_DEFAULTS);
  });

  it("prefers inline exec directives, then persisted session overrides, then agent defaults", () => {
    const sessionEntry = createSessionEntry({
      execHost: "gateway",
      execSecurity: "deny",
    });

    expect(
      resolveReplyExecOverrides({
        directives: parseInlineDirectives("/exec host=auto security=full"),
        sessionEntry,
        agentExecDefaults: AGENT_EXEC_DEFAULTS,
      }),
    ).toEqual({
      ...AGENT_EXEC_DEFAULTS,
      host: "auto",
      security: "full",
    });

    expect(
      resolveReplyExecOverrides({
        directives: parseInlineDirectives("run a command"),
        sessionEntry,
        agentExecDefaults: AGENT_EXEC_DEFAULTS,
      }),
    ).toEqual({
      ...AGENT_EXEC_DEFAULTS,
      host: "gateway",
      security: "deny",
    });
  });

  it("resolves the latest persisted exec directive for later turns", async () => {
    const sessionEntry = createSessionEntry();
    const sessionStore = { "agent:main:main": sessionEntry };

    await persistExecDirective({
      sessionEntry,
      sessionStore,
      body: "/exec host=gateway security=deny ask=off",
    });
    await persistExecDirective({
      sessionEntry,
      sessionStore,
      body: "/exec host=gateway security=full ask=always",
    });

    expect(
      resolveReplyExecOverrides({
        directives: parseInlineDirectives("run a command"),
        sessionEntry,
        agentExecDefaults: AGENT_EXEC_DEFAULTS,
      }),
    ).toEqual({
      ...AGENT_EXEC_DEFAULTS,
      host: "gateway",
      security: "full",
      ask: "always",
    });
  });
});
