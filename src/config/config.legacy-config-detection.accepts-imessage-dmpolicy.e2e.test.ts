import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const { loadConfig, migrateLegacyConfig, readConfigFileSnapshot, validateConfigObject } =
  await vi.importActual<typeof import("./config.js")>("./config.js");
import { withTempHome } from "./test-helpers.js";

async function expectLoadRejectionPreservesField(params: {
  config: unknown;
  readValue: (parsed: unknown) => unknown;
  expectedValue: unknown;
}) {
  await withTempHome(async (home) => {
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(params.config, null, 2), "utf-8");

    const snap = await readConfigFileSnapshot();

    expect(snap.valid).toBe(false);
    expect(snap.issues.length).toBeGreaterThan(0);

    const parsed = JSON.parse(await fs.readFile(configPath, "utf-8")) as unknown;
    expect(params.readValue(parsed)).toBe(params.expectedValue);
  });
}

function expectValidConfigValue(params: {
  config: unknown;
  readValue: (config: unknown) => unknown;
  expectedValue: unknown;
}) {
  const res = validateConfigObject(params.config);
  expect(res.ok).toBe(true);
  if (!res.ok) {
    throw new Error("expected config to be valid");
  }
  expect(params.readValue(res.config)).toBe(params.expectedValue);
}

function expectInvalidIssuePath(config: unknown, expectedPath: string) {
  const res = validateConfigObject(config);
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.issues[0]?.path).toBe(expectedPath);
  }
}

describe("legacy config detection", () => {
  it('accepts imessage.dmPolicy="open" with allowFrom "*"', async () => {
    const res = validateConfigObject({
      channels: { imessage: { dmPolicy: "open", allowFrom: ["*"] } },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.channels?.imessage?.dmPolicy).toBe("open");
    }
  });
  it.each([
    [
      "defaults imessage.dmPolicy to pairing when imessage section exists",
      { channels: { imessage: {} } },
      (config: unknown) =>
        (config as { channels?: { imessage?: { dmPolicy?: string } } }).channels?.imessage
          ?.dmPolicy,
      "pairing",
    ],
    [
      "defaults imessage.groupPolicy to allowlist when imessage section exists",
      { channels: { imessage: {} } },
      (config: unknown) =>
        (config as { channels?: { imessage?: { groupPolicy?: string } } }).channels?.imessage
          ?.groupPolicy,
      "allowlist",
    ],
    [
      "defaults discord.groupPolicy to allowlist when discord section exists",
      { channels: { discord: {} } },
      (config: unknown) =>
        (config as { channels?: { discord?: { groupPolicy?: string } } }).channels?.discord
          ?.groupPolicy,
      "allowlist",
    ],
    [
      "defaults slack.groupPolicy to allowlist when slack section exists",
      { channels: { slack: {} } },
      (config: unknown) =>
        (config as { channels?: { slack?: { groupPolicy?: string } } }).channels?.slack
          ?.groupPolicy,
      "allowlist",
    ],
    [
      "defaults msteams.groupPolicy to allowlist when msteams section exists",
      { channels: { msteams: {} } },
      (config: unknown) =>
        (config as { channels?: { msteams?: { groupPolicy?: string } } }).channels?.msteams
          ?.groupPolicy,
      "allowlist",
    ],
  ])("defaults: %s", (_name, config, readValue, expectedValue) => {
    expectValidConfigValue({ config, readValue, expectedValue });
  });
  it("rejects unsafe executable config values", async () => {
    const res = validateConfigObject({
      channels: { imessage: { cliPath: "imsg; rm -rf /" } },
      audio: { transcription: { command: ["whisper", "--model", "base"] } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.path === "channels.imessage.cliPath")).toBe(true);
    }
  });
  it("accepts tools audio transcription without cli", async () => {
    const res = validateConfigObject({
      audio: { transcription: { command: ["whisper", "--model", "base"] } },
    });
    expect(res.ok).toBe(true);
  });
  it("accepts path-like executable values with spaces", async () => {
    const res = validateConfigObject({
      channels: { imessage: { cliPath: "/Applications/Imsg Tools/imsg" } },
      audio: {
        transcription: {
          command: ["whisper", "--model"],
        },
      },
    });
    expect(res.ok).toBe(true);
  });
  it.each([
    [
      'rejects discord.dm.policy="open" without allowFrom "*"',
      { channels: { discord: { dm: { policy: "open", allowFrom: ["123"] } } } },
      "channels.discord.dm.allowFrom",
    ],
    [
      'rejects discord.dmPolicy="open" without allowFrom "*"',
      { channels: { discord: { dmPolicy: "open", allowFrom: ["123"] } } },
      "channels.discord.allowFrom",
    ],
    [
      'rejects slack.dm.policy="open" without allowFrom "*"',
      { channels: { slack: { dm: { policy: "open", allowFrom: ["U123"] } } } },
      "channels.slack.dm.allowFrom",
    ],
    [
      'rejects slack.dmPolicy="open" without allowFrom "*"',
      { channels: { slack: { dmPolicy: "open", allowFrom: ["U123"] } } },
      "channels.slack.allowFrom",
    ],
  ])("rejects: %s", (_name, config, expectedPath) => {
    expectInvalidIssuePath(config, expectedPath);
  });

  it.each([
    {
      name: 'accepts discord dm.allowFrom="*" with top-level allowFrom alias',
      config: {
        channels: { discord: { dm: { policy: "open", allowFrom: ["123"] }, allowFrom: ["*"] } },
      },
    },
    {
      name: 'accepts slack dm.allowFrom="*" with top-level allowFrom alias',
      config: {
        channels: { slack: { dm: { policy: "open", allowFrom: ["U123"] }, allowFrom: ["*"] } },
      },
    },
  ])("$name", ({ config }) => {
    const res = validateConfigObject(config);
    expect(res.ok).toBe(true);
  });
  it("rejects legacy agent.model string", async () => {
    const res = validateConfigObject({
      agent: { model: "anthropic/claude-opus-4-5" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.path === "agent.model")).toBe(true);
    }
  });
  it("migrates telegram.requireMention to channels.telegram.groups.*.requireMention", async () => {
    const res = migrateLegacyConfig({
      telegram: { requireMention: false },
    });
    expect(res.changes).toContain(
      'Moved telegram.requireMention → channels.telegram.groups."*".requireMention.',
    );
    expect(res.config?.channels?.telegram?.groups?.["*"]?.requireMention).toBe(false);
    expect(
      (res.config?.channels?.telegram as { requireMention?: boolean } | undefined)?.requireMention,
    ).toBeUndefined();
  });
  it("migrates messages.tts.enabled to messages.tts.auto", async () => {
    const res = migrateLegacyConfig({
      messages: { tts: { enabled: true } },
    });
    expect(res.changes).toContain("Moved messages.tts.enabled → messages.tts.auto (always).");
    expect(res.config?.messages?.tts?.auto).toBe("always");
    expect(res.config?.messages?.tts?.enabled).toBeUndefined();
  });
  it("migrates legacy model config to agent.models + model lists", async () => {
    const res = migrateLegacyConfig({
      agent: {
        model: "anthropic/claude-opus-4-5",
        modelFallbacks: ["openai/gpt-4.1-mini"],
        imageModel: "openai/gpt-4.1-mini",
        imageModelFallbacks: ["anthropic/claude-opus-4-5"],
        allowedModels: ["anthropic/claude-opus-4-5", "openai/gpt-4.1-mini"],
        modelAliases: { Opus: "anthropic/claude-opus-4-5" },
      },
    });

    expect(res.config?.agents?.defaults?.model?.primary).toBe("anthropic/claude-opus-4-5");
    expect(res.config?.agents?.defaults?.model?.fallbacks).toEqual(["openai/gpt-4.1-mini"]);
    expect(res.config?.agents?.defaults?.imageModel?.primary).toBe("openai/gpt-4.1-mini");
    expect(res.config?.agents?.defaults?.imageModel?.fallbacks).toEqual([
      "anthropic/claude-opus-4-5",
    ]);
    expect(res.config?.agents?.defaults?.models?.["anthropic/claude-opus-4-5"]).toMatchObject({
      alias: "Opus",
    });
    expect(res.config?.agents?.defaults?.models?.["openai/gpt-4.1-mini"]).toBeTruthy();
    expect((res.config as { agent?: unknown } | undefined)?.agent).toBeUndefined();
  });
  it("flags legacy config in snapshot", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({ routing: { allowFrom: ["+15555550123"] } }),
        "utf-8",
      );

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(false);
      expect(snap.legacyIssues.some((issue) => issue.path === "routing.allowFrom")).toBe(true);

      const raw = await fs.readFile(configPath, "utf-8");
      const parsed = JSON.parse(raw) as {
        routing?: { allowFrom?: string[] };
        channels?: unknown;
      };
      expect(parsed.routing?.allowFrom).toEqual(["+15555550123"]);
      expect(parsed.channels).toBeUndefined();
    });
  });
  it("flags top-level memorySearch as legacy in snapshot", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({ memorySearch: { provider: "local", fallback: "none" } }),
        "utf-8",
      );

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(false);
      expect(snap.legacyIssues.some((issue) => issue.path === "memorySearch")).toBe(true);
    });
  });
  it("does not auto-migrate claude-cli auth profile mode on load", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
            auth: {
              profiles: {
                "anthropic:claude-cli": { provider: "anthropic", mode: "token" },
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const cfg = loadConfig();
      expect(cfg.auth?.profiles?.["anthropic:claude-cli"]?.mode).toBe("token");

      const raw = await fs.readFile(configPath, "utf-8");
      const parsed = JSON.parse(raw) as {
        auth?: { profiles?: Record<string, { mode?: string }> };
      };
      expect(parsed.auth?.profiles?.["anthropic:claude-cli"]?.mode).toBe("token");
    });
  });
  it("flags legacy provider sections in snapshot", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({ whatsapp: { allowFrom: ["+1555"] } }, null, 2),
        "utf-8",
      );

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(false);
      expect(snap.legacyIssues.some((issue) => issue.path === "whatsapp")).toBe(true);

      const raw = await fs.readFile(configPath, "utf-8");
      const parsed = JSON.parse(raw) as {
        channels?: unknown;
        whatsapp?: unknown;
      };
      expect(parsed.channels).toBeUndefined();
      expect(parsed.whatsapp).toBeTruthy();
    });
  });
  it("flags routing.allowFrom in snapshot", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({ routing: { allowFrom: ["+1666"] } }, null, 2),
        "utf-8",
      );

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(false);
      expect(snap.legacyIssues.some((issue) => issue.path === "routing.allowFrom")).toBe(true);

      const raw = await fs.readFile(configPath, "utf-8");
      const parsed = JSON.parse(raw) as {
        channels?: unknown;
        routing?: { allowFrom?: string[] };
      };
      expect(parsed.channels).toBeUndefined();
      expect(parsed.routing?.allowFrom).toEqual(["+1666"]);
    });
  });
  it("rejects bindings[].match.provider on load", async () => {
    await expectLoadRejectionPreservesField({
      config: {
        bindings: [{ agentId: "main", match: { provider: "slack" } }],
      },
      readValue: (parsed) =>
        (parsed as { bindings?: Array<{ match?: { provider?: string } }> }).bindings?.[0]?.match
          ?.provider,
      expectedValue: "slack",
    });
  });
  it("rejects bindings[].match.accountID on load", async () => {
    await expectLoadRejectionPreservesField({
      config: {
        bindings: [{ agentId: "main", match: { channel: "telegram", accountID: "work" } }],
      },
      readValue: (parsed) =>
        (parsed as { bindings?: Array<{ match?: { accountID?: string } }> }).bindings?.[0]?.match
          ?.accountID,
      expectedValue: "work",
    });
  });
  it("accepts bindings[].comment on load", () => {
    expectValidConfigValue({
      config: {
        bindings: [{ agentId: "main", comment: "primary route", match: { channel: "telegram" } }],
      },
      readValue: (config) =>
        (config as { bindings?: Array<{ comment?: string }> }).bindings?.[0]?.comment,
      expectedValue: "primary route",
    });
  });
  it("rejects session.sendPolicy.rules[].match.provider on load", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
            session: {
              sendPolicy: {
                rules: [{ action: "deny", match: { provider: "telegram" } }],
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(false);
      expect(snap.issues.length).toBeGreaterThan(0);

      const raw = await fs.readFile(configPath, "utf-8");
      const parsed = JSON.parse(raw) as {
        session?: { sendPolicy?: { rules?: Array<{ match?: { provider?: string } }> } };
      };
      expect(parsed.session?.sendPolicy?.rules?.[0]?.match?.provider).toBe("telegram");
    });
  });
  it("rejects messages.queue.byProvider on load", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({ messages: { queue: { byProvider: { whatsapp: "queue" } } } }, null, 2),
        "utf-8",
      );

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(false);
      expect(snap.issues.length).toBeGreaterThan(0);

      const raw = await fs.readFile(configPath, "utf-8");
      const parsed = JSON.parse(raw) as {
        messages?: {
          queue?: {
            byProvider?: Record<string, unknown>;
          };
        };
      };
      expect(parsed.messages?.queue?.byProvider?.whatsapp).toBe("queue");
    });
  });
});
