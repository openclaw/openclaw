import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSessionMessageIdentity } from "../../packages/gateway-client/src/session-projection-message-identity.js";
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import { resolveAgentRunSessionTarget } from "../agents/run-session-target.js";
import { guardSessionManager } from "../agents/session-tool-result-guard-wrapper.js";
import { SessionManager } from "../agents/sessions/index.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveMemoryAudienceFromEntry } from "../plugins/memory-audience.js";
import { createRuntimeAgent } from "../plugins/runtime/runtime-agent.js";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "../sessions/model-overrides.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { consultRealtimeVoiceAgent } from "./agent-consult-runtime.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "voice-consult-store" });
});
afterEach(async () => {
  await state.cleanup();
});

describe("voice consult concrete store ownership", () => {
  it("preserves live run identity through transcript storage and redaction", async () => {
    const runIdPrefix = "zoom-meetings:zoom_meeting_11111111-2222-4333-8444-123456789012";
    const cfg: OpenClawConfig = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
    };
    const runIds: string[] = [];
    const secret = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const runEmbeddedAgent = vi.fn(async (params: RunEmbeddedAgentParams) => {
      const target = await resolveAgentRunSessionTarget({
        ...params,
        missingSessionKey: "resolve-existing",
      });
      expect(params.runId).toBe(runIds.at(-1));
      expect(params.runId.startsWith(runIdPrefix)).toBe(true);
      const manager = SessionManager.open(target, state.workspaceDir);
      guardSessionManager(manager, {
        config: cfg,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        runId: params.runId,
      }).appendMessage(makeAgentAssistantMessage({ content: [{ type: "text", text: secret }] }));
      const persisted = SessionManager.open(target, state.workspaceDir)
        .getEntries()
        .filter((entry) => entry.type === "message");
      expect(persisted.map((entry) => readSessionMessageIdentity(entry.message)?.runId)).toEqual(
        runIds,
      );
      expect(JSON.stringify(persisted)).not.toContain(secret);
      return { payloads: [{ text: "Checked" }], meta: { durationMs: 0 } };
    });
    const agentRuntime = { ...createRuntimeAgent(), runEmbeddedAgent };
    for (let turn = 0; turn < 2; turn++) {
      await expect(
        consultRealtimeVoiceAgent({
          cfg,
          agentRuntime,
          logger: { warn: vi.fn() },
          sessionKey: "agent:main:voice-identity",
          messageProvider: "webchat",
          lane: "talk",
          runIdPrefix,
          args: { question: "Check this" },
          transcript: [],
          surface: "test voice",
          userLabel: "User",
          onRunStarted: ({ runId }) => {
            runIds.push(runId);
          },
        }),
      ).resolves.toEqual({ text: "Checked" });
    }
    expect(new Set(runIds).size).toBe(2);
  });

  it.each([
    { parentAgentId: "main", locked: false },
    { parentAgentId: "other", locked: false },
    { parentAgentId: "main", locked: true },
  ])(
    "keeps parent $parentAgentId policy and routing in its configured store (locked=$locked)",
    async ({ parentAgentId, locked }) => {
      const cfg: OpenClawConfig = {
        agents: {
          entries: { main: { workspace: state.workspaceDir }, other: {} },
          ownership: "explicit",
        },
      };
      const runEmbeddedAgent = vi.fn(async () => ({
        payloads: [{ text: "Checked" }],
        meta: { durationMs: 0 },
      }));
      const agentRuntime = { ...createRuntimeAgent(), runEmbeddedAgent };
      const spawnedBy = `agent:${parentAgentId}:parent`;
      const parentStore = agentRuntime.session.resolveStorePath(cfg.session?.store, {
        agentId: parentAgentId,
      });
      const createdActor = {
        type: "human" as const,
        source: "profile" as const,
        id: "parent-creator",
      };
      await replaceSessionEntry(
        { agentId: parentAgentId, sessionKey: spawnedBy, storePath: parentStore },
        {
          sessionId: "parent-session",
          updatedAt: 1,
          createdVia: "operator",
          createdActor,
          sandbox: "required",
          modelSelectionLocked: locked,
          delivery: normalizeSessionDeliveryState({
            context: { channel: "discord", to: "channel:synthetic", accountId: "test-account" },
          }),
        },
      );
      const sessionKey = "agent:main:voice-child";
      const storePath = state.statePath("consult", "sessions.sqlite");
      const consult = consultRealtimeVoiceAgent({
        cfg,
        agentRuntime,
        logger: { warn: vi.fn() },
        agentId: "main",
        sessionKey,
        storePath,
        spawnedBy,
        contextMode: "isolated",
        messageProvider: "webchat",
        lane: "talk",
        runIdPrefix: "test-consult",
        args: { question: "Check this" },
        transcript: [],
        surface: "test voice",
        userLabel: "User",
      });
      if (locked) {
        await expect(consult).rejects.toThrow(MODEL_SELECTION_LOCKED_MESSAGE);
        expect(runEmbeddedAgent).not.toHaveBeenCalled();
        expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toBeUndefined();
        return;
      }
      await expect(consult).resolves.toEqual({ text: "Checked" });
      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toMatchObject({
        sandbox: "required",
        createdActor,
        spawnedBy,
      });
      expect(runEmbeddedAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          messageProvider: "discord",
          messageTo: "channel:synthetic",
          agentAccountId: "test-account",
          sessionTarget: expect.objectContaining({ agentId: "main", sessionKey, storePath }),
        }),
      );
    },
  );
});

it.each([
  { chatType: "direct", senderIsOwner: true, contextMode: "fork", audience: "owner-private" },
  // Meeting consults pass no ingress owner bit, so they never inherit owner-private memory.
  { chatType: "direct", senderIsOwner: undefined, contextMode: "fork", audience: "conversation" },
  { chatType: "group", senderIsOwner: true, contextMode: "isolated", audience: "conversation" },
] as const)(
  "consult children of a $chatType root (owner=$senderIsOwner, $contextMode) resolve $audience memory",
  async ({ chatType, senderIsOwner, contextMode, audience }) => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
    };
    const agentRuntime = {
      ...createRuntimeAgent(),
      runEmbeddedAgent: vi.fn(async () => ({
        payloads: [{ text: "Checked" }],
        meta: { durationMs: 0 },
      })),
    };
    const storePath = agentRuntime.session.resolveStorePath(cfg.session?.store, {
      agentId: "main",
    });
    const rootKey = chatType === "group" ? "agent:main:qa-channel:group:room" : "agent:main:main";
    const root = {
      sessionId: randomUUID(),
      lifecycleRevision: randomUUID(),
      chatType,
      updatedAt: 1,
    };
    await replaceSessionEntry({ agentId: "main", sessionKey: rootKey, storePath }, root);
    const sessionKey = "agent:main:subagent:meet:consult";
    await expect(
      consultRealtimeVoiceAgent({
        cfg,
        agentRuntime,
        logger: { warn: vi.fn() },
        agentId: "main",
        sessionKey,
        spawnedBy: rootKey,
        senderIsOwner,
        contextMode,
        messageProvider: "webchat",
        lane: "talk",
        runIdPrefix: "lineage-consult",
        args: { question: "Check this" },
        transcript: [],
        surface: "test voice",
        userLabel: "User",
      }),
    ).resolves.toEqual({ text: "Checked" });
    const child = loadSessionEntry({ agentId: "main", sessionKey, storePath })!;
    expect(child).toMatchObject({
      spawnedBy: rootKey,
      spawnedBySessionId: root.sessionId,
      parentSessionLifecycleRevision: root.lifecycleRevision,
      spawnedBySenderIsOwner: senderIsOwner === true,
    });
    // The consult child's own turn is never the owner; only its receipt can carry that bit.
    const resolution = await resolveMemoryAudienceFromEntry(
      { agentId: "main", sessionKey, sessionId: child.sessionId, senderIsOwner: false, storePath },
      child,
    );
    expect(resolution).toMatchObject({ status: "granted", audience: { kind: audience } });
    if (resolution.status === "granted") {
      resolution.release();
    }
  },
);
