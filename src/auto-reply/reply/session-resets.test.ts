import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { buildModelAliasIndex } from "../../agents/model-selection.js";
import { saveSessionStore } from "../../config/sessions.js";
import { formatZonedTimestamp } from "../../infra/format-time/format-datetime.ts";
import { enqueueSystemEvent, resetSystemEventsForTest } from "../../infra/system-events.js";
import { applyResetModelOverride } from "./session-reset-model.js";
import { prependSystemEvents } from "./session-updates.js";
import { initSessionState } from "./session.js";

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(async () => [
    { provider: "minimax", id: "m2.1", name: "M2.1" },
    { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
  ]),
}));

let suiteRoot = "";
let suiteCase = 0;

beforeAll(async () => {
  suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-resets-suite-"));
});

afterAll(async () => {
  await fs.rm(suiteRoot, { recursive: true, force: true });
  suiteRoot = "";
  suiteCase = 0;
});

async function createStorePath(prefix: string): Promise<string> {
  const root = path.join(suiteRoot, `${prefix}${++suiteCase}`);
  await fs.mkdir(root);
  return path.join(root, "sessions.json");
}

describe("initSessionState reset triggers in WhatsApp groups", () => {
  async function seedSessionStore(params: {
    storePath: string;
    sessionKey: string;
    sessionId: string;
  }): Promise<void> {
    await saveSessionStore(params.storePath, {
      [params.sessionKey]: {
        sessionId: params.sessionId,
        updatedAt: Date.now(),
      },
    });
  }

  function makeCfg(params: { storePath: string; allowFrom: string[] }): OpenClawConfig {
    return {
      session: { store: params.storePath, idleMinutes: 999 },
      channels: {
        whatsapp: {
          allowFrom: params.allowFrom,
          groupPolicy: "open",
        },
      },
    } as OpenClawConfig;
  }

  it("Reset trigger /new works for authorized sender in WhatsApp group", async () => {
    const storePath = await createStorePath("openclaw-group-reset-");
    const sessionKey = "agent:main:whatsapp:group:120363406150318674@g.us";
    const existingSessionId = "existing-session-123";
    await seedSessionStore({
      storePath,
      sessionKey,
      sessionId: existingSessionId,
    });

    const cfg = makeCfg({
      storePath,
      allowFrom: ["+41796666864"],
    });

    const groupMessageCtx = {
      Body: `[Chat messages since your last reply - for context]\\n[WhatsApp 120363406150318674@g.us 2026-01-13T07:45Z] Someone: hello\\n\\n[Current message - respond to this]\\n[WhatsApp 120363406150318674@g.us 2026-01-13T07:45Z] Peschiño: /new\\n[from: Peschiño (+41796666864)]`,
      RawBody: "/new",
      CommandBody: "/new",
      From: "120363406150318674@g.us",
      To: "+41779241027",
      ChatType: "group",
      SessionKey: sessionKey,
      Provider: "whatsapp",
      Surface: "whatsapp",
      SenderName: "Peschiño",
      SenderE164: "+41796666864",
      SenderId: "41796666864:0@s.whatsapp.net",
    };

    const result = await initSessionState({
      ctx: groupMessageCtx,
      cfg,
      commandAuthorized: true,
    });

    expect(result.triggerBodyNormalized).toBe("/new");
    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
    expect(result.bodyStripped).toBe("");
  });

  it("Reset trigger /new blocked for unauthorized sender in existing session", async () => {
    const storePath = await createStorePath("openclaw-group-reset-unauth-");
    const sessionKey = "agent:main:whatsapp:group:120363406150318674@g.us";
    const existingSessionId = "existing-session-123";

    await seedSessionStore({
      storePath,
      sessionKey,
      sessionId: existingSessionId,
    });

    const cfg = makeCfg({
      storePath,
      allowFrom: ["+41796666864"],
    });

    const groupMessageCtx = {
      Body: `[Context]\\n[WhatsApp ...] OtherPerson: /new\\n[from: OtherPerson (+1555123456)]`,
      RawBody: "/new",
      CommandBody: "/new",
      From: "120363406150318674@g.us",
      To: "+41779241027",
      ChatType: "group",
      SessionKey: sessionKey,
      Provider: "whatsapp",
      Surface: "whatsapp",
      SenderName: "OtherPerson",
      SenderE164: "+1555123456",
      SenderId: "1555123456:0@s.whatsapp.net",
    };

    const result = await initSessionState({
      ctx: groupMessageCtx,
      cfg,
      commandAuthorized: true,
    });

    expect(result.triggerBodyNormalized).toBe("/new");
    expect(result.sessionId).toBe(existingSessionId);
    expect(result.isNewSession).toBe(false);
  });

  it("Reset trigger works when RawBody is clean but Body has wrapped context", async () => {
    const storePath = await createStorePath("openclaw-group-rawbody-");
    const sessionKey = "agent:main:whatsapp:group:g1";
    const existingSessionId = "existing-session-123";
    await seedSessionStore({
      storePath,
      sessionKey,
      sessionId: existingSessionId,
    });

    const cfg = makeCfg({
      storePath,
      allowFrom: ["*"],
    });

    const groupMessageCtx = {
      Body: `[WhatsApp 120363406150318674@g.us 2026-01-13T07:45Z] Jake: /new\n[from: Jake (+1222)]`,
      RawBody: "/new",
      CommandBody: "/new",
      From: "120363406150318674@g.us",
      To: "+1111",
      ChatType: "group",
      SessionKey: sessionKey,
      Provider: "whatsapp",
      SenderE164: "+1222",
    };

    const result = await initSessionState({
      ctx: groupMessageCtx,
      cfg,
      commandAuthorized: true,
    });

    expect(result.triggerBodyNormalized).toBe("/new");
    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
    expect(result.bodyStripped).toBe("");
  });

  it("Reset trigger /new works when SenderId is LID but SenderE164 is authorized", async () => {
    const storePath = await createStorePath("openclaw-group-reset-lid-");
    const sessionKey = "agent:main:whatsapp:group:120363406150318674@g.us";
    const existingSessionId = "existing-session-123";
    await seedSessionStore({
      storePath,
      sessionKey,
      sessionId: existingSessionId,
    });

    const cfg = makeCfg({
      storePath,
      allowFrom: ["+41796666864"],
    });

    const groupMessageCtx = {
      Body: `[WhatsApp 120363406150318674@g.us 2026-01-13T07:45Z] Owner: /new\n[from: Owner (+41796666864)]`,
      RawBody: "/new",
      CommandBody: "/new",
      From: "120363406150318674@g.us",
      To: "+41779241027",
      ChatType: "group",
      SessionKey: sessionKey,
      Provider: "whatsapp",
      Surface: "whatsapp",
      SenderName: "Owner",
      SenderE164: "+41796666864",
      SenderId: "123@lid",
    };

    const result = await initSessionState({
      ctx: groupMessageCtx,
      cfg,
      commandAuthorized: true,
    });

    expect(result.triggerBodyNormalized).toBe("/new");
    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
    expect(result.bodyStripped).toBe("");
  });

  it("Reset trigger /new blocked when SenderId is LID but SenderE164 is unauthorized", async () => {
    const storePath = await createStorePath("openclaw-group-reset-lid-unauth-");
    const sessionKey = "agent:main:whatsapp:group:120363406150318674@g.us";
    const existingSessionId = "existing-session-123";
    await seedSessionStore({
      storePath,
      sessionKey,
      sessionId: existingSessionId,
    });

    const cfg = makeCfg({
      storePath,
      allowFrom: ["+41796666864"],
    });

    const groupMessageCtx = {
      Body: `[WhatsApp 120363406150318674@g.us 2026-01-13T07:45Z] Other: /new\n[from: Other (+1555123456)]`,
      RawBody: "/new",
      CommandBody: "/new",
      From: "120363406150318674@g.us",
      To: "+41779241027",
      ChatType: "group",
      SessionKey: sessionKey,
      Provider: "whatsapp",
      Surface: "whatsapp",
      SenderName: "Other",
      SenderE164: "+1555123456",
      SenderId: "123@lid",
    };

    const result = await initSessionState({
      ctx: groupMessageCtx,
      cfg,
      commandAuthorized: true,
    });

    expect(result.triggerBodyNormalized).toBe("/new");
    expect(result.sessionId).toBe(existingSessionId);
    expect(result.isNewSession).toBe(false);
  });
});

describe("initSessionState reset triggers in Slack channels", () => {
  async function seedSessionStore(params: {
    storePath: string;
    sessionKey: string;
    sessionId: string;
  }): Promise<void> {
    const { saveSessionStore } = await import("../../config/sessions.js");
    await saveSessionStore(params.storePath, {
      [params.sessionKey]: {
        sessionId: params.sessionId,
        updatedAt: Date.now(),
      },
    });
  }

  it("Reset trigger /reset works when Slack message has a leading <@...> mention token", async () => {
    const storePath = await createStorePath("openclaw-slack-channel-reset-");
    const sessionKey = "agent:main:slack:channel:c1";
    const existingSessionId = "existing-session-123";
    await seedSessionStore({
      storePath,
      sessionKey,
      sessionId: existingSessionId,
    });

    const cfg = {
      session: { store: storePath, idleMinutes: 999 },
    } as OpenClawConfig;

    const channelMessageCtx = {
      Body: "<@U123> /reset",
      RawBody: "<@U123> /reset",
      CommandBody: "<@U123> /reset",
      From: "slack:channel:C1",
      To: "channel:C1",
      ChatType: "channel",
      SessionKey: sessionKey,
      Provider: "slack",
      Surface: "slack",
      SenderId: "U123",
      SenderName: "Owner",
    };

    const result = await initSessionState({
      ctx: channelMessageCtx,
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
    expect(result.bodyStripped).toBe("");
  });

  it("Reset trigger /new preserves args when Slack message has a leading <@...> mention token", async () => {
    const storePath = await createStorePath("openclaw-slack-channel-new-");
    const sessionKey = "agent:main:slack:channel:c2";
    const existingSessionId = "existing-session-123";
    await seedSessionStore({
      storePath,
      sessionKey,
      sessionId: existingSessionId,
    });

    const cfg = {
      session: { store: storePath, idleMinutes: 999 },
    } as OpenClawConfig;

    const channelMessageCtx = {
      Body: "<@U123> /new take notes",
      RawBody: "<@U123> /new take notes",
      CommandBody: "<@U123> /new take notes",
      From: "slack:channel:C2",
      To: "channel:C2",
      ChatType: "channel",
      SessionKey: sessionKey,
      Provider: "slack",
      Surface: "slack",
      SenderId: "U123",
      SenderName: "Owner",
    };

    const result = await initSessionState({
      ctx: channelMessageCtx,
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
    expect(result.bodyStripped).toBe("take notes");
  });
});

describe("applyResetModelOverride", () => {
  it("selects a model hint and strips it from the body", async () => {
    const cfg = {} as OpenClawConfig;
    const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: "openai" });
    const sessionEntry = {
      sessionId: "s1",
      updatedAt: Date.now(),
    };
    const sessionStore = { "agent:main:dm:1": sessionEntry };
    const sessionCtx = { BodyStripped: "minimax summarize" };
    const ctx = { ChatType: "direct" };

    await applyResetModelOverride({
      cfg,
      resetTriggered: true,
      bodyStripped: "minimax summarize",
      sessionCtx,
      ctx,
      sessionEntry,
      sessionStore,
      sessionKey: "agent:main:dm:1",
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      aliasIndex,
    });

    expect(sessionEntry.providerOverride).toBe("minimax");
    expect(sessionEntry.modelOverride).toBe("m2.1");
    expect(sessionCtx.BodyStripped).toBe("summarize");
  });

  it("clears auth profile overrides when reset applies a model", async () => {
    const cfg = {} as OpenClawConfig;
    const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: "openai" });
    const sessionEntry = {
      sessionId: "s1",
      updatedAt: Date.now(),
      authProfileOverride: "anthropic:default",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 2,
    };
    const sessionStore = { "agent:main:dm:1": sessionEntry };
    const sessionCtx = { BodyStripped: "minimax summarize" };
    const ctx = { ChatType: "direct" };

    await applyResetModelOverride({
      cfg,
      resetTriggered: true,
      bodyStripped: "minimax summarize",
      sessionCtx,
      ctx,
      sessionEntry,
      sessionStore,
      sessionKey: "agent:main:dm:1",
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      aliasIndex,
    });

    expect(sessionEntry.authProfileOverride).toBeUndefined();
    expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
    expect(sessionEntry.authProfileOverrideCompactionCount).toBeUndefined();
  });

  it("skips when resetTriggered is false", async () => {
    const cfg = {} as OpenClawConfig;
    const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: "openai" });
    const sessionEntry = {
      sessionId: "s1",
      updatedAt: Date.now(),
    };
    const sessionStore = { "agent:main:dm:1": sessionEntry };
    const sessionCtx = { BodyStripped: "minimax summarize" };
    const ctx = { ChatType: "direct" };

    await applyResetModelOverride({
      cfg,
      resetTriggered: false,
      bodyStripped: "minimax summarize",
      sessionCtx,
      ctx,
      sessionEntry,
      sessionStore,
      sessionKey: "agent:main:dm:1",
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      aliasIndex,
    });

    expect(sessionEntry.providerOverride).toBeUndefined();
    expect(sessionEntry.modelOverride).toBeUndefined();
    expect(sessionCtx.BodyStripped).toBe("minimax summarize");
  });
});

describe("initSessionState preserves behavior overrides across /new and /reset", () => {
  async function seedSessionStoreWithOverrides(params: {
    storePath: string;
    sessionKey: string;
    sessionId: string;
    overrides: Record<string, unknown>;
  }): Promise<void> {
    const { saveSessionStore } = await import("../../config/sessions.js");
    await saveSessionStore(params.storePath, {
      [params.sessionKey]: {
        sessionId: params.sessionId,
        updatedAt: Date.now(),
        ...params.overrides,
      },
    });
  }

  it("/new preserves verboseLevel from previous session", async () => {
    const storePath = await createStorePath("openclaw-reset-verbose-");
    const sessionKey = "agent:main:telegram:dm:user1";
    const existingSessionId = "existing-session-verbose";
    await seedSessionStoreWithOverrides({
      storePath,
      sessionKey,
      sessionId: existingSessionId,
      overrides: { verboseLevel: "on" },
    });

    const cfg = {
      session: { store: storePath, idleMinutes: 999 },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "/new",
        RawBody: "/new",
        CommandBody: "/new",
        From: "user1",
        To: "bot",
        ChatType: "direct",
        SessionKey: sessionKey,
        Provider: "telegram",
        Surface: "telegram",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
    expect(result.sessionEntry.verboseLevel).toBe("on");
  });

  it("/reset preserves thinkingLevel and reasoningLevel from previous session", async () => {
    const storePath = await createStorePath("openclaw-reset-thinking-");
    const sessionKey = "agent:main:telegram:dm:user2";
    const existingSessionId = "existing-session-thinking";
    await seedSessionStoreWithOverrides({
      storePath,
      sessionKey,
      sessionId: existingSessionId,
      overrides: { thinkingLevel: "full", reasoningLevel: "high" },
    });

    const cfg = {
      session: { store: storePath, idleMinutes: 999 },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "/reset",
        RawBody: "/reset",
        CommandBody: "/reset",
        From: "user2",
        To: "bot",
        ChatType: "direct",
        SessionKey: sessionKey,
        Provider: "telegram",
        Surface: "telegram",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(true);
    expect(result.sessionEntry.thinkingLevel).toBe("full");
    expect(result.sessionEntry.reasoningLevel).toBe("high");
  });

  it("/new preserves ttsAuto from previous session", async () => {
    const storePath = await createStorePath("openclaw-reset-tts-");
    const sessionKey = "agent:main:telegram:dm:user3";
    const existingSessionId = "existing-session-tts";
    await seedSessionStoreWithOverrides({
      storePath,
      sessionKey,
      sessionId: existingSessionId,
      overrides: { ttsAuto: "on" },
    });

    const cfg = {
      session: { store: storePath, idleMinutes: 999 },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "/new",
        RawBody: "/new",
        CommandBody: "/new",
        From: "user3",
        To: "bot",
        ChatType: "direct",
        SessionKey: sessionKey,
        Provider: "telegram",
        Surface: "telegram",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.sessionEntry.ttsAuto).toBe("on");
  });

  it("archives previous transcript file on /new reset", async () => {
    const storePath = await createStorePath("openclaw-reset-archive-");
    const sessionKey = "agent:main:telegram:dm:user-archive";
    const existingSessionId = "existing-session-archive";
    await seedSessionStoreWithOverrides({
      storePath,
      sessionKey,
      sessionId: existingSessionId,
      overrides: {},
    });
    const transcriptPath = path.join(path.dirname(storePath), `${existingSessionId}.jsonl`);
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({ message: { role: "user", content: "hello" } })}\n`,
      "utf-8",
    );

    const cfg = {
      session: { store: storePath, idleMinutes: 999 },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "/new",
        RawBody: "/new",
        CommandBody: "/new",
        From: "user-archive",
        To: "bot",
        ChatType: "direct",
        SessionKey: sessionKey,
        Provider: "telegram",
        Surface: "telegram",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(true);
    const files = await fs.readdir(path.dirname(storePath));
    expect(files.some((f) => f.startsWith(`${existingSessionId}.jsonl.reset.`))).toBe(true);
  });

  it("idle-based new session does NOT preserve overrides (no entry to read)", async () => {
    const storePath = await createStorePath("openclaw-idle-no-preserve-");
    const sessionKey = "agent:main:telegram:dm:new-user";

    const cfg = {
      session: { store: storePath, idleMinutes: 0 },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "hello",
        RawBody: "hello",
        CommandBody: "hello",
        From: "new-user",
        To: "bot",
        ChatType: "direct",
        SessionKey: sessionKey,
        Provider: "telegram",
        Surface: "telegram",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(false);
    expect(result.sessionEntry.verboseLevel).toBeUndefined();
    expect(result.sessionEntry.thinkingLevel).toBeUndefined();
  });
});

describe("prependSystemEvents", () => {
  it("adds a local timestamp to queued system events by default", async () => {
    vi.useFakeTimers();
    try {
      const timestamp = new Date("2026-01-12T20:19:17Z");
      const expectedTimestamp = formatZonedTimestamp(timestamp, { displaySeconds: true });
      vi.setSystemTime(timestamp);

      enqueueSystemEvent("Model switched.", { sessionKey: "agent:main:main" });

      const result = await prependSystemEvents({
        cfg: {} as OpenClawConfig,
        sessionKey: "agent:main:main",
        isMainSession: false,
        isNewSession: false,
        prefixedBodyBase: "User: hi",
      });

      expect(expectedTimestamp).toBeDefined();
      expect(result).toContain(`System: [${expectedTimestamp}] Model switched.`);
    } finally {
      resetSystemEventsForTest();
      vi.useRealTimers();
    }
  });
});
