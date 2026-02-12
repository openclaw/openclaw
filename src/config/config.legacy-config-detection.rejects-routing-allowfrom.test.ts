import { describe, expect, it, vi } from "vitest";

describe("legacy config detection", () => {
  it("rejects routing.allowFrom", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      routing: { allowFrom: ["+15555550123"] },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("routing.allowFrom");
    }
  });
  it("rejects routing.groupChat.requireMention", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      routing: { groupChat: { requireMention: false } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("routing.groupChat.requireMention");
    }
  });
  it("migrates routing.allowFrom to channels.whatsapp.allowFrom when whatsapp configured", async () => {
    vi.resetModules();
    const { migrateLegacyConfig } = await import("./config.js");
    const res = migrateLegacyConfig({
      routing: { allowFrom: ["+15555550123"] },
      channels: { whatsapp: {} },
    });
    expect(res.changes).toContain("Moved routing.allowFrom → channels.whatsapp.allowFrom.");
    expect(res.config?.channels?.whatsapp?.allowFrom).toEqual(["+15555550123"]);
    expect(res.config?.routing?.allowFrom).toBeUndefined();
  });
  it("drops routing.allowFrom when whatsapp missing", async () => {
    vi.resetModules();
    const { migrateLegacyConfig } = await import("./config.js");
    const res = migrateLegacyConfig({
      routing: { allowFrom: ["+15555550123"] },
    });
    expect(res.changes).toContain("Removed routing.allowFrom (channels.whatsapp not configured).");
    expect(res.config?.channels?.whatsapp).toBeUndefined();
    expect(res.config?.routing?.allowFrom).toBeUndefined();
  });
  it("migrates routing.groupChat.requireMention to channels whatsapp/telegram/imessage groups when whatsapp configured", async () => {
    vi.resetModules();
    const { migrateLegacyConfig } = await import("./config.js");
    const res = migrateLegacyConfig({
      routing: { groupChat: { requireMention: false } },
      channels: { whatsapp: {} },
    });
    expect(res.changes).toContain(
      'Moved routing.groupChat.requireMention → channels.whatsapp.groups."*".requireMention.',
    );
    expect(res.changes).toContain(
      'Moved routing.groupChat.requireMention → channels.telegram.groups."*".requireMention.',
    );
    expect(res.changes).toContain(
      'Moved routing.groupChat.requireMention → channels.imessage.groups."*".requireMention.',
    );
    expect(res.config?.channels?.whatsapp?.groups?.["*"]?.requireMention).toBe(false);
    expect(res.config?.channels?.telegram?.groups?.["*"]?.requireMention).toBe(false);
    expect(res.config?.channels?.imessage?.groups?.["*"]?.requireMention).toBe(false);
    expect(res.config?.routing?.groupChat?.requireMention).toBeUndefined();
  });
  it("migrates routing.groupChat.requireMention to telegram/imessage when whatsapp missing", async () => {
    vi.resetModules();
    const { migrateLegacyConfig } = await import("./config.js");
    const res = migrateLegacyConfig({
      routing: { groupChat: { requireMention: false } },
    });
    expect(res.changes).toContain(
      'Moved routing.groupChat.requireMention → channels.telegram.groups."*".requireMention.',
    );
    expect(res.changes).toContain(
      'Moved routing.groupChat.requireMention → channels.imessage.groups."*".requireMention.',
    );
    expect(res.changes).not.toContain(
      'Moved routing.groupChat.requireMention → channels.whatsapp.groups."*".requireMention.',
    );
    expect(res.config?.channels?.whatsapp).toBeUndefined();
    expect(res.config?.channels?.telegram?.groups?.["*"]?.requireMention).toBe(false);
    expect(res.config?.channels?.imessage?.groups?.["*"]?.requireMention).toBe(false);
    expect(res.config?.routing?.groupChat?.requireMention).toBeUndefined();
  });
  it("migrates routing.groupChat.mentionPatterns to messages.groupChat.mentionPatterns", async () => {
    vi.resetModules();
    const { migrateLegacyConfig } = await import("./config.js");
    const res = migrateLegacyConfig({
      routing: { groupChat: { mentionPatterns: ["@openclaw"] } },
    });
    expect(res.changes).toContain(
      "Moved routing.groupChat.mentionPatterns → messages.groupChat.mentionPatterns.",
    );
    expect(res.config?.messages?.groupChat?.mentionPatterns).toEqual(["@openclaw"]);
    expect(res.config?.routing?.groupChat?.mentionPatterns).toBeUndefined();
  });
  it("migrates routing agentToAgent/queue/transcribeAudio to tools/messages/media", async () => {
    vi.resetModules();
    const { migrateLegacyConfig } = await import("./config.js");
    const res = migrateLegacyConfig({
      routing: {
        agentToAgent: { enabled: true, allow: ["main"] },
        queue: { mode: "queue", cap: 3 },
        transcribeAudio: {
          command: ["whisper", "--model", "base"],
          timeoutSeconds: 2,
        },
      },
    });
    expect(res.changes).toContain("Moved routing.agentToAgent → tools.agentToAgent.");
    expect(res.changes).toContain("Moved routing.queue → messages.queue.");
    expect(res.changes).toContain("Moved routing.transcribeAudio → tools.media.audio.models.");
    expect(res.config?.tools?.agentToAgent).toEqual({
      enabled: true,
      allow: ["main"],
    });
    expect(res.config?.messages?.queue).toEqual({
      mode: "queue",
      cap: 3,
    });
    expect(res.config?.tools?.media?.audio).toEqual({
      enabled: true,
      models: [
        {
          command: "whisper",
          type: "cli",
          args: ["--model", "base"],
          timeoutSeconds: 2,
        },
      ],
    });
    expect(res.config?.routing).toBeUndefined();
  });
  it("migrates agent config into agents.defaults and tools", async () => {
    vi.resetModules();
    const { migrateLegacyConfig } = await import("./config.js");
    const res = migrateLegacyConfig({
      agent: {
        model: "openai/gpt-5.2",
        tools: { allow: ["sessions.list"], deny: ["danger"] },
        elevated: { enabled: true, allowFrom: { discord: ["user:1"] } },
        bash: { timeoutSec: 12 },
        sandbox: { tools: { allow: ["browser.open"] } },
        subagents: { tools: { deny: ["sandbox"] } },
      },
    });
    expect(res.changes).toContain("Moved agent.tools.allow → tools.allow.");
    expect(res.changes).toContain("Moved agent.tools.deny → tools.deny.");
    expect(res.changes).toContain("Moved agent.elevated → tools.elevated.");
    expect(res.changes).toContain("Moved agent.bash → tools.exec.");
    expect(res.changes).toContain("Moved agent.sandbox.tools → tools.sandbox.tools.");
    expect(res.changes).toContain("Moved agent.subagents.tools → tools.subagents.tools.");
    expect(res.changes).toContain("Moved agent → agents.defaults.");
    expect(res.config?.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.2",
      fallbacks: [],
    });
    expect(res.config?.tools?.allow).toEqual(["sessions.list"]);
    expect(res.config?.tools?.deny).toEqual(["danger"]);
    expect(res.config?.tools?.elevated).toEqual({
      enabled: true,
      allowFrom: { discord: ["user:1"] },
    });
    expect(res.config?.tools?.exec).toEqual({ timeoutSec: 12 });
    expect(res.config?.tools?.sandbox?.tools).toEqual({
      allow: ["browser.open"],
    });
    expect(res.config?.tools?.subagents?.tools).toEqual({
      deny: ["sandbox"],
    });
    expect((res.config as { agent?: unknown }).agent).toBeUndefined();
  });
  it("migrates top-level memorySearch to agents.defaults.memorySearch", async () => {
    vi.resetModules();
    const { migrateLegacyConfig } = await import("./config.js");
    const res = migrateLegacyConfig({
      memorySearch: {
        provider: "local",
        fallback: "none",
        query: { maxResults: 7 },
      },
    });
    expect(res.changes).toContain("Moved memorySearch → agents.defaults.memorySearch.");
    expect(res.config?.agents?.defaults?.memorySearch).toMatchObject({
      provider: "local",
      fallback: "none",
      query: { maxResults: 7 },
    });
    expect((res.config as { memorySearch?: unknown }).memorySearch).toBeUndefined();
  });
  it("merges top-level memorySearch into agents.defaults.memorySearch", async () => {
    vi.resetModules();
    const { migrateLegacyConfig } = await import("./config.js");
    const res = migrateLegacyConfig({
      memorySearch: {
        provider: "local",
        fallback: "none",
        query: { maxResults: 7 },
      },
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
          },
        },
      },
    });
    expect(res.changes).toContain(
      "Merged memorySearch → agents.defaults.memorySearch (filled missing fields from legacy; kept explicit agents.defaults values).",
    );
    expect(res.config?.agents?.defaults?.memorySearch).toMatchObject({
      provider: "openai",
      model: "text-embedding-3-small",
      fallback: "none",
      query: { maxResults: 7 },
    });
  });
  it("keeps nested agents.defaults.memorySearch values when merging legacy defaults", async () => {
    vi.resetModules();
    const { migrateLegacyConfig } = await import("./config.js");
    const res = migrateLegacyConfig({
      memorySearch: {
        query: {
          maxResults: 7,
          minScore: 0.25,
          hybrid: { enabled: true, textWeight: 0.8, vectorWeight: 0.2 },
        },
      },
      agents: {
        defaults: {
          memorySearch: {
            query: {
              maxResults: 3,
              hybrid: { enabled: false },
            },
          },
        },
      },
    });

    expect(res.config?.agents?.defaults?.memorySearch).toMatchObject({
      query: {
        maxResults: 3,
        minScore: 0.25,
        hybrid: { enabled: false, textWeight: 0.8, vectorWeight: 0.2 },
      },
    });
  });
  it("migrates tools.bash to tools.exec", async () => {
    vi.resetModules();
    const { migrateLegacyConfig } = await import("./config.js");
    const res = migrateLegacyConfig({
      tools: {
        bash: { timeoutSec: 12 },
      },
    });
    expect(res.changes).toContain("Moved tools.bash → tools.exec.");
    expect(res.config?.tools?.exec).toEqual({ timeoutSec: 12 });
    expect((res.config?.tools as { bash?: unknown } | undefined)?.bash).toBeUndefined();
  });
  it("accepts per-agent tools.elevated overrides", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      tools: {
        elevated: {
          allowFrom: { whatsapp: ["+15555550123"] },
        },
      },
      agents: {
        list: [
          {
            id: "work",
            workspace: "~/openclaw-work",
            tools: {
              elevated: {
                enabled: false,
                allowFrom: { whatsapp: ["+15555550123"] },
              },
            },
          },
        ],
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config?.agents?.list?.[0]?.tools?.elevated).toEqual({
        enabled: false,
        allowFrom: { whatsapp: ["+15555550123"] },
      });
    }
  });
  it("rejects telegram.requireMention", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      telegram: { requireMention: true },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((issue) => issue.path === "telegram.requireMention")).toBe(true);
    }
  });
  it("rejects gateway.token", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      gateway: { token: "legacy-token" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("gateway.token");
    }
  });
  it("migrates gateway.token to gateway.auth.token", async () => {
    vi.resetModules();
    const { migrateLegacyConfig } = await import("./config.js");
    const res = migrateLegacyConfig({
      gateway: { token: "legacy-token" },
    });
    expect(res.changes).toContain("Moved gateway.token → gateway.auth.token.");
    expect(res.config?.gateway?.auth?.token).toBe("legacy-token");
    expect(res.config?.gateway?.auth?.mode).toBe("token");
    expect((res.config?.gateway as { token?: string })?.token).toBeUndefined();
  });
  it("keeps gateway.bind tailnet", async () => {
    vi.resetModules();
    const { migrateLegacyConfig, validateConfigObject } = await import("./config.js");
    const res = migrateLegacyConfig({
      gateway: { bind: "tailnet" as const },
    });
    expect(res.changes).not.toContain("Migrated gateway.bind from 'tailnet' to 'auto'.");
    expect(res.config).toBeNull();

    const validated = validateConfigObject({ gateway: { bind: "tailnet" as const } });
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.config.gateway?.bind).toBe("tailnet");
    }
  });
  it('rejects telegram.dmPolicy="open" without allowFrom "*"', async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      channels: { telegram: { dmPolicy: "open", allowFrom: ["123456789"] } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("channels.telegram.allowFrom");
    }
  });
  it('accepts telegram.dmPolicy="open" with allowFrom "*"', async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.channels?.telegram?.dmPolicy).toBe("open");
    }
  });
  it("defaults telegram.dmPolicy to pairing when telegram section exists", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({ channels: { telegram: {} } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.channels?.telegram?.dmPolicy).toBe("pairing");
    }
  });
  it("defaults telegram.groupPolicy to allowlist when telegram section exists", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({ channels: { telegram: {} } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.channels?.telegram?.groupPolicy).toBe("allowlist");
    }
  });
  it("defaults telegram.streamMode to partial when telegram section exists", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({ channels: { telegram: {} } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.channels?.telegram?.streamMode).toBe("partial");
    }
  });
  it('rejects whatsapp.dmPolicy="open" without allowFrom "*"', async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      channels: {
        whatsapp: { dmPolicy: "open", allowFrom: ["+15555550123"] },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("channels.whatsapp.allowFrom");
    }
  });
  it('accepts whatsapp.dmPolicy="open" with allowFrom "*"', async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      channels: { whatsapp: { dmPolicy: "open", allowFrom: ["*"] } },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.channels?.whatsapp?.dmPolicy).toBe("open");
    }
  });
  it("defaults whatsapp.dmPolicy to pairing when whatsapp section exists", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({ channels: { whatsapp: {} } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.channels?.whatsapp?.dmPolicy).toBe("pairing");
    }
  });
  it("defaults whatsapp.groupPolicy to allowlist when whatsapp section exists", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({ channels: { whatsapp: {} } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.channels?.whatsapp?.groupPolicy).toBe("allowlist");
    }
  });
  it('rejects signal.dmPolicy="open" without allowFrom "*"', async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      channels: { signal: { dmPolicy: "open", allowFrom: ["+15555550123"] } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("channels.signal.allowFrom");
    }
  });
  it('accepts signal.dmPolicy="open" with allowFrom "*"', async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      channels: { signal: { dmPolicy: "open", allowFrom: ["*"] } },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.channels?.signal?.dmPolicy).toBe("open");
    }
  });
  it("defaults signal.dmPolicy to pairing when signal section exists", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({ channels: { signal: {} } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.channels?.signal?.dmPolicy).toBe("pairing");
    }
  });
  it("defaults signal.groupPolicy to allowlist when signal section exists", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({ channels: { signal: {} } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.channels?.signal?.groupPolicy).toBe("allowlist");
    }
  });
  it("accepts historyLimit overrides per provider and account", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      messages: { groupChat: { historyLimit: 12 } },
      channels: {
        whatsapp: { historyLimit: 9, accounts: { work: { historyLimit: 4 } } },
        telegram: { historyLimit: 8, accounts: { ops: { historyLimit: 3 } } },
        slack: { historyLimit: 7, accounts: { ops: { historyLimit: 2 } } },
        signal: { historyLimit: 6 },
        imessage: { historyLimit: 5 },
        msteams: { historyLimit: 4 },
        discord: { historyLimit: 3 },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.channels?.whatsapp?.historyLimit).toBe(9);
      expect(res.config.channels?.whatsapp?.accounts?.work?.historyLimit).toBe(4);
      expect(res.config.channels?.telegram?.historyLimit).toBe(8);
      expect(res.config.channels?.telegram?.accounts?.ops?.historyLimit).toBe(3);
      expect(res.config.channels?.slack?.historyLimit).toBe(7);
      expect(res.config.channels?.slack?.accounts?.ops?.historyLimit).toBe(2);
      expect(res.config.channels?.signal?.historyLimit).toBe(6);
      expect(res.config.channels?.imessage?.historyLimit).toBe(5);
      expect(res.config.channels?.msteams?.historyLimit).toBe(4);
      expect(res.config.channels?.discord?.historyLimit).toBe(3);
    }
  });
  it('rejects imessage.dmPolicy="open" without allowFrom "*"', async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      channels: {
        imessage: { dmPolicy: "open", allowFrom: ["+15555550123"] },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("channels.imessage.allowFrom");
    }
  });
});
