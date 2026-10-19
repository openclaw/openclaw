import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../../config/sessions/session-accessor.sqlite-read.js";
import { readAssistantDisplayContent } from "../../shared/assistant-display-content.js";
import { readClawHubRecommendations } from "../../shared/clawhub-recommendations.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { extractMessagingToolSourceReplyPayload } from "../embedded-agent-messaging-extraction.js";
import { createMessageTool } from "./message-tool-execution.js";

const registry = vi.hoisted(() => ({
  plugins: vi.fn(),
  local: vi.fn(),
  install: vi.fn(),
  skills: vi.fn(),
  skillStatus: vi.fn(),
}));
vi.mock("../../infra/clawhub-plugin-catalog.js", () => ({
  fetchClawHubPluginCatalog: registry.plugins,
}));
vi.mock("../../plugins/management-service.js", () => ({ listManagedPlugins: registry.local }));
// mock-isolation: Recommendation tests must never activate the real ClawHub install path.
vi.mock("../../plugins/clawhub.js", () => ({ installPluginFromClawHub: registry.install }));
vi.mock("../../infra/clawhub-skills.js", () => ({ searchClawHubSkills: registry.skills }));
vi.mock("../../skills/discovery/status.js", () => ({
  prepareWorkspaceSkillStatus: async (...args: unknown[]) => ({
    report: registry.skillStatus(...args),
    files: [],
  }),
}));

const remotePlugin = {
  packageName: "@openclaw/whatsapp",
  displayName: "WhatsApp",
  family: "code-plugin",
  isOfficial: true,
  categories: ["channels"],
  runtimeId: "whatsapp",
};
const catalog = { version: 0, channels: [], getChannel: () => undefined } as const;

function messageTool(config = {}, options: Partial<Parameters<typeof createMessageTool>[0]> = {}) {
  setRuntimeConfigSnapshot(options.config ?? config);
  return createMessageTool({
    config,
    preparedMessageToolCatalog: catalog,
    currentChannelProvider: "webchat",
    agentSessionKey: "agent:main:webchat:dm:clawhub-proof",
    runId: "clawhub-proof-run",
    ...options,
  });
}

beforeEach(() => {
  registry.plugins.mockReset().mockResolvedValue({ items: [remotePlugin] });
  registry.local
    .mockReset()
    .mockResolvedValue({ plugins: [], diagnostics: [], mutationAllowed: true });
  registry.install.mockReset();
  registry.skills.mockReset().mockResolvedValue([]);
  registry.skillStatus.mockReset().mockReturnValue({ skills: [] });
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
});

describe("ClawHub message recommendations", () => {
  it.each([false, true])(
    "persists an official query-only card with owner-verified installed=%s and replays it once",
    async (installed) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "clawhub-message-proof-" },
        async (state) => {
          registry.local.mockResolvedValue({
            plugins: installed
              ? [
                  {
                    id: "whatsapp",
                    name: "Local WhatsApp",
                    clawhubPackage: remotePlugin.packageName,
                    installed: true,
                    enabled: false,
                    state: "needs-setup",
                  },
                ]
              : [],
            diagnostics: [],
            mutationAllowed: true,
          });
          const sessionKey = "agent:main:webchat:dm:clawhub-proof";
          const sessionId = "clawhub-proof-session";
          const storePath = path.join(
            state.stateDir,
            "agents",
            "main",
            "sessions",
            "sessions.json",
          );
          const scope = { agentId: "main", sessionKey, sessionId, storePath };
          await replaceSessionEntry(scope, { sessionId, updatedAt: 1 });
          const config = {
            agents: { entries: { main: { workspace: state.workspaceDir } } },
          };
          const tool = messageTool(config, {
            agentId: "main",
            sessionId,
            workspaceDir: state.workspaceDir,
          });
          const args = { action: "send", clawhub: { query: "whatsapp" } };
          const result = await tool.execute("clawhub-proof-call", args);
          const reply = extractMessagingToolSourceReplyPayload(result);
          const cards = readClawHubRecommendations(reply?.channelData);
          expect(cards).toEqual([
            expect.objectContaining({
              type: "clawhub",
              kind: "plugin",
              name: "WhatsApp",
              official: true,
              installed,
              id: "ch_QG9wZW5jbGF3L3doYXRzYXBw",
            }),
          ]);
          const statusText = `WhatsApp: ${installed ? "Installed" : "Available to install"}.`;
          expect(reply?.text).toBe(statusText);
          expect(result.content).toEqual([
            { type: "text", text: expect.stringContaining(statusText) },
          ]);
          expect(registry.install).not.toHaveBeenCalled();

          await tool.execute("clawhub-proof-call", args);
          const messages = (await loadTranscriptEvents(scope))
            .map(readTranscriptEventMessage)
            .filter((message) => message?.role === "assistant");
          expect(messages).toHaveLength(1);
          expect(readAssistantDisplayContent(messages[0])).toEqual([
            cards[0],
            { type: "text", text: reply?.text },
          ]);
          expect(messages[0]?.content).toEqual([{ type: "text", text: reply?.text }]);
        },
      );
    },
  );

  it.each([undefined, "", " \t\n"])(
    "excludes unverified publisher claims and gives a visible no-match outcome for message=%j",
    async (message) => {
      registry.plugins.mockResolvedValue({ items: [{ ...remotePlugin, isOfficial: false }] });
      registry.skills.mockResolvedValue([
        {
          slug: "whatsapp",
          installRef: "@openclaw/whatsapp",
          ownerHandle: "openclaw",
          displayName: "WhatsApp",
          official: false,
        },
      ]);
      const result = await messageTool().execute("no-match", {
        action: "send",
        message,
        clawhub: { query: "whatsapp" },
      });
      const reply = extractMessagingToolSourceReplyPayload(result);
      expect(readClawHubRecommendations(reply?.channelData)).toEqual([]);
      expect(reply?.text).toContain("No official ClawHub plugin or skill match");
      expect(result.content).toEqual([
        {
          type: "text",
          text: expect.stringContaining("No official ClawHub plugin or skill match"),
        },
      ]);
    },
  );

  it("rejects ordinary send content before capability discovery", async () => {
    await expect(
      messageTool().execute("mixed-send", {
        action: "send",
        message: "Deployment complete. All requested checks passed.",
        clawhub: { query: "whatsapp" },
      }),
    ).rejects.toThrow(/ordinary send fields \(message\)/i);
    expect(registry.plugins).not.toHaveBeenCalled();
    expect(registry.skills).not.toHaveBeenCalled();
    expect(registry.local).not.toHaveBeenCalled();
  });

  it("matches an official skill to its exact linked publisher instead of its display name", async () => {
    registry.skills.mockResolvedValue([
      {
        slug: "calendar",
        installRef: "@verified/calendar",
        ownerHandle: "verified",
        displayName: "Calendar",
        official: true,
        icon: "📆",
      },
    ]);
    registry.skillStatus.mockReturnValue({
      skills: [
        {
          clawhub: {
            valid: true,
            registry: "https://clawhub.ai",
            slug: "calendar",
            ownerHandle: "another",
          },
        },
      ],
    });
    const tool = messageTool({}, { workspaceDir: "/workspace" });
    const result = await tool.execute("skill-card", {
      action: "send",
      clawhub: {
        query: "calendar",
        kind: "skill",
        intro: "Here is your calendar capability.",
      },
    });
    expect(extractMessagingToolSourceReplyPayload(result)?.text).toBe(
      "Here is your calendar capability.",
    );
    expect(
      readClawHubRecommendations(extractMessagingToolSourceReplyPayload(result)?.channelData),
    ).toEqual([
      expect.objectContaining({
        kind: "skill",
        id: "@verified/calendar",
        skillRef: "@verified/calendar",
        installed: false,
        official: true,
      }),
    ]);
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining("Calendar: Available to install.") },
    ]);
  });

  it("rejects accidental status payloads before discovery or transcript persistence", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "clawhub-message-mixed-guard-" },
      async (state) => {
        const sessionKey = "agent:main:webchat:dm:clawhub-proof";
        const sessionId = "clawhub-mixed-guard-session";
        const storePath = path.join(state.stateDir, "agents", "main", "sessions", "sessions.json");
        const scope = { agentId: "main", sessionKey, sessionId, storePath };
        await replaceSessionEntry(scope, { sessionId, updatedAt: 1 });
        const config = {
          agents: { entries: { main: { workspace: state.workspaceDir } } },
        };
        const tool = messageTool(config, {
          agentId: "main",
          sessionId,
          workspaceDir: state.workspaceDir,
        });

        for (const query of [
          "x",
          "taskflow",
          "merge pull request",
          "__none__",
          "taskflow assisted release status",
        ]) {
          await expect(
            tool.execute(`mixed-${query}`, {
              action: "send",
              message: "Release status: merged; deployment remains gated.",
              clawhub: { query },
            }),
          ).rejects.toThrow();
        }

        expect(registry.plugins).not.toHaveBeenCalled();
        expect(registry.skills).not.toHaveBeenCalled();
        expect(registry.local).not.toHaveBeenCalled();
        const messages = (await loadTranscriptEvents(scope))
          .map(readTranscriptEventMessage)
          .filter((message) => message?.role === "assistant");
        expect(messages).toEqual([]);
      },
    );
  });

  it("sanitizes recommendation intro text before capability discovery", async () => {
    const result = await messageTool().execute("suppressed-intro", {
      action: "send",
      clawhub: {
        query: "whatsapp",
        intro:
          "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nBOOT.md: private\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
      },
    });
    expect(result.details).toMatchObject({
      status: "suppressed",
      reason: "internal_runtime_context_echo",
    });
    expect(registry.plugins).not.toHaveBeenCalled();
    expect(registry.skills).not.toHaveBeenCalled();
    expect(registry.local).not.toHaveBeenCalled();
  });

  it.each(["R", "C#", "C++", "x", "__none__"])(
    "accepts nonblank compatibility query %j",
    async (query) => {
      await messageTool().execute(`compatibility-${query}`, {
        action: "send",
        clawhub: { query },
      });
      expect(registry.plugins).toHaveBeenCalledWith({
        query,
        intent: "official",
        limit: 3,
      });
      expect(registry.local).toHaveBeenCalledOnce();
      expect(registry.install).not.toHaveBeenCalled();
    },
  );

  it.each(["", " ", "\t\n"])("rejects blank query %j before catalog discovery", async (query) => {
    await expect(
      messageTool().execute(`blank-${JSON.stringify(query)}`, {
        action: "send",
        clawhub: { query },
      }),
    ).rejects.toThrow(/too small/i);
    expect(registry.plugins).not.toHaveBeenCalled();
    expect(registry.skills).not.toHaveBeenCalled();
    expect(registry.local).not.toHaveBeenCalled();
  });

  it("limits pure recommendations to three official cards without installing", async () => {
    const extraRemotePlugins: (typeof remotePlugin)[] = [];
    for (const runtimeId of ["signal", "telegram", "matrix"]) {
      extraRemotePlugins.push({
        ...remotePlugin,
        packageName: `@openclaw/${runtimeId}`,
        displayName: runtimeId[0]?.toUpperCase() + runtimeId.slice(1),
        runtimeId,
      });
    }
    registry.plugins.mockResolvedValue({ items: [remotePlugin, ...extraRemotePlugins] });

    const result = await messageTool().execute("three-card-limit", {
      action: "send",
      clawhub: { query: "messaging channel" },
    });
    const cards = readClawHubRecommendations(
      extractMessagingToolSourceReplyPayload(result)?.channelData,
    );

    expect(cards).toHaveLength(3);
    expect(cards.every((card) => card.official)).toBe(true);
    expect(registry.plugins).toHaveBeenCalledWith({
      query: "messaging channel",
      intent: "official",
      limit: 3,
    });
    expect(registry.local).toHaveBeenCalledOnce();
    expect(registry.install).not.toHaveBeenCalled();
  });

  it("rejects model-supplied installation and official claims", async () => {
    await expect(
      messageTool().execute("forged-status", {
        action: "send",
        clawhub: { query: "whatsapp", installed: true, official: true },
      }),
    ).rejects.toThrow();
    expect(registry.plugins).not.toHaveBeenCalled();
  });

  it("documents the compatibility-preserving guarded schema", () => {
    expect(messageTool().parameters).toHaveProperty(
      "properties.clawhub.properties.query.minLength",
      1,
    );
    expect(messageTool().parameters).toHaveProperty("properties.clawhub.properties.intro");
    expect(messageTool({}, { currentChannelProvider: "telegram" }).parameters).not.toHaveProperty(
      "properties.clawhub",
    );
  });
});
