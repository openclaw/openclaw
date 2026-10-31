import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  discordVoiceTranscriptsSourceProvider,
  setDiscordTranscriptsVoiceManager,
} from "../extensions/discord/test-api.js";
import { createTranscriptsTool } from "../src/agents/tools/transcripts-tool.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../src/plugins/registry-empty.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../src/state/openclaw-state-db.js";
import { activeSessions } from "../src/transcripts/capture-startup.js";
import { TranscriptsStore } from "../src/transcripts/store.js";
import { createTempDirTracker } from "./helpers/temp-dir.js";

type DiscordTranscriptsVoiceManager = NonNullable<
  Parameters<typeof setDiscordTranscriptsVoiceManager>[0]["manager"]
>;

const tempDirs = createTempDirTracker();
let store: TranscriptsStore;

function createTool(config: OpenClawConfig, accountId = "account-a", senderId = "allowed") {
  return createTranscriptsTool({
    agentId: "main",
    caller: {
      kind: "channel",
      channel: "discord",
      accountId,
      senderId,
      groupSpace: "guild-a",
      roleIds: [],
    },
    config,
  });
}

function makeConfig(otherAccount = false): OpenClawConfig {
  return {
    channels: {
      discord: {
        accounts: {
          "account-a": {
            token: "token-a",
            allowFrom: ["discord:allowed"],
            voice: { enabled: true },
          },
          ...(otherAccount ? { "account-b": { token: "token-b", voice: { enabled: true } } } : {}),
        },
      },
    },
    transcripts: { enabled: true },
  };
}

async function expectHidden(tool: ReturnType<typeof createTool>, label: string, actions: string[]) {
  await expect(tool.execute(`status-${label}`, { action: "status" })).resolves.toMatchObject({
    details: { active: [] },
  });
  for (const action of actions) {
    await expect(
      tool.execute(`${action}-${label}`, { action, sessionId: "account-bound" }),
    ).rejects.toThrow("transcripts session not found: account-bound");
  }
}

describe("transcripts tool with the registered Discord provider", () => {
  beforeEach(() => {
    const stateDir = tempDirs.make("openclaw-transcripts-discord-provider-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    store = new TranscriptsStore(path.join(stateDir, "transcripts"), { env: process.env });
    const registry = createEmptyPluginRegistry();
    registry.transcriptSourceProviders.push({
      pluginId: "discord",
      provider: discordVoiceTranscriptsSourceProvider,
      source: "extensions/discord/index.ts",
    });
    setActivePluginRegistry(registry, "discord-transcripts-tool-test");
  });

  const managers = new Map<string, DiscordTranscriptsVoiceManager>();
  function registerManager(accountId: string, message = `joined ${accountId}`) {
    const join = vi.fn(async () => ({ ok: true, message }));
    const leave = vi.fn(async () => {});
    const manager: DiscordTranscriptsVoiceManager = {
      hasRealtimeCapture: () => false,
      startTranscriptsCapture: join,
      stopTranscriptsCapture: leave,
      watchChannelOccupancy: () => () => {},
      resolveAccessTarget: async ({ channelId }) => ({
        channelName: channelId,
        channelSlug: channelId,
        scope: "channel",
      }),
    };
    managers.set(accountId, manager);
    setDiscordTranscriptsVoiceManager({ accountId, manager });
    return { join, leave };
  }
  afterEach(async () => {
    for (const entry of activeSessions.values()) {
      await discordVoiceTranscriptsSourceProvider.stop!({
        sessionId: entry.session.sessionId,
        source: entry.session.source,
      });
    }
    activeSessions.clear();
    for (const [accountId, manager] of managers) {
      setDiscordTranscriptsVoiceManager({ accountId, manager: null, expectedManager: manager });
    }
    managers.clear();
    setActivePluginRegistry(createEmptyPluginRegistry(), "discord-transcripts-tool-test-cleanup");
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    tempDirs.cleanup();
  });

  it("keeps a model-requested account switch on the trusted Discord account", async () => {
    const { join: accountAJoin, leave: accountALeave } = registerManager("account-a");
    const { join: accountBJoin, leave: accountBLeave } = registerManager("account-b");
    const config = makeConfig(true);
    const ownerTool = createTool(config);
    const otherAccountTool = createTool(config, "account-b");
    const deniedSameAccountTool = createTool(config, "account-a", "blocked");

    const startResult = await ownerTool.execute("start-account-bound", {
      action: "start",
      providerId: "discord-voice",
      accountId: "account-b",
      guildId: "guild-a",
      channelId: "voice-a",
      sessionId: "account-bound",
    });

    expect(startResult.details).toMatchObject({
      accountId: "account-a",
      sessionId: "account-bound",
    });
    expect(accountAJoin).toHaveBeenCalledOnce();
    expect(accountBJoin).not.toHaveBeenCalled();
    await expect(store.readSession("account-bound")).resolves.toMatchObject({
      source: { accountId: "account-a" },
      metadata: { agentId: "main" },
    });

    await expectHidden(otherAccountTool, "other-account", ["stop"]);
    expect(accountBLeave).not.toHaveBeenCalled();

    await expectHidden(deniedSameAccountTool, "denied-sender", ["summarize", "stop"]);
    expect(accountALeave).not.toHaveBeenCalled();

    await expect(
      ownerTool.execute("stop-owner-account", {
        action: "stop",
        sessionId: "account-bound",
      }),
    ).resolves.toMatchObject({ details: { sessionId: "account-bound" } });
    expect(accountALeave).toHaveBeenCalledOnce();
  });

  it("rejects a Discord sender that the voice command policy denies", async () => {
    const { join } = registerManager("account-a", "joined");
    const deniedTool = createTool(makeConfig(), "account-a", "blocked");

    await expect(
      deniedTool.execute("denied-sender", {
        action: "start",
        providerId: "discord-voice",
        guildId: "guild-a",
        channelId: "voice-a",
        sessionId: "denied-sender",
      }),
    ).rejects.toThrow("not authorized");
    expect(join).not.toHaveBeenCalled();
    await expect(store.readSession("denied-sender")).resolves.toBeUndefined();
  });
});
