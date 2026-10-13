import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSessionMessageIdentity } from "../../packages/gateway-client/src/session-projection-message-identity.js";
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import { resolveAgentRunSessionTarget } from "../agents/run-session-target.js";
import { resolveSandboxRuntimeStatusAsync } from "../agents/sandbox/runtime-status.js";
import { guardSessionManager } from "../agents/session-tool-result-guard-wrapper.js";
import { SessionManager } from "../agents/sessions/index.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import {
  appendTranscriptMessage,
  assignSessionOwner,
  loadSessionEntry,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
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
  it.each(
    [false, true].flatMap((enabled) =>
      (["isolated", "fork"] as const).map((contextMode) => ({ enabled, contextMode })),
    ),
  )(
    "retains delegated causality through $contextMode consults with Lab $enabled",
    async ({ enabled, contextMode }) => {
      const cfg: OpenClawConfig = {
        agents: {
          entries: { main: { workspace: state.workspaceDir } },
          defaults: { experimental: { delegatedCreatorAttribution: enabled } },
        },
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
      const creator = { type: "human", source: "profile", id: "task-creator" } as const;
      const parentKey = "agent:main:delegated-task";
      await replaceSessionEntry(
        { agentId: "main", storePath, sessionKey: parentKey },
        {
          sessionId: "delegated-task",
          updatedAt: 1,
          createdVia: "spawn",
          createdActor: creator,
        },
      );
      const assignment = assignSessionOwner(
        { agentId: "main", storePath, sessionKey: parentKey },
        {
          owner: { type: "human", id: "different-assignee" },
          assignedAt: 1,
          assignedBy: { type: "system", id: "fixture" },
        },
      );
      expect(assignment?.actor).toEqual({ type: "human", id: "different-assignee" });
      expect(
        loadSessionEntry({ agentId: "main", storePath, sessionKey: parentKey })?.owner,
      ).toEqual(assignment);
      let sourceKey = parentKey;
      for (const suffix of ["first", "follow-on"]) {
        const source = loadSessionEntry({ agentId: "main", storePath, sessionKey: sourceKey })!;
        if (contextMode === "fork") {
          await appendTranscriptMessage(
            { agentId: "main", storePath, sessionKey: sourceKey, sessionId: source.sessionId },
            {
              eventId: `input-${suffix}`,
              message: {
                role: "user",
                content: [{ type: "text", text: "Synthetic consult context" }],
                timestamp: 2,
              },
              now: 2,
            },
          );
        }
        const sessionKey = `agent:main:consult-${suffix}`;
        await expect(
          consultRealtimeVoiceAgent({
            cfg,
            agentRuntime,
            logger: { warn: vi.fn() },
            agentId: "main",
            storePath,
            sessionKey,
            spawnedBy: sourceKey,
            contextMode,
            messageProvider: "webchat",
            lane: "talk",
            runIdPrefix: "causal-consult",
            args: { question: "Check" },
            transcript: [],
            surface: "test voice",
            userLabel: "User",
          }),
        ).resolves.toEqual({ text: "Checked" });
        const stored = loadSessionEntry({ agentId: "main", storePath, sessionKey });
        expect(stored?.createdActor).toEqual(enabled ? creator : { type: "agent", id: sourceKey });
        expect(stored?.sandboxProvenance).toEqual({ actor: { type: "agent", id: sourceKey } });
        expect(stored?.sandbox).toBeUndefined();
        expect(stored?.publicShare).toBeUndefined();
        if (contextMode === "fork") {
          expect(stored?.forkSource?.sessionKey).toBe(sourceKey);
        }
        expect(
          await agentRuntime.session.getSessionEntryAsync({
            agentId: "main",
            storePath,
            sessionKey,
          }),
        ).not.toHaveProperty("sandboxProvenance");
        sourceKey = sessionKey;
      }
      expect(
        loadSessionEntry({ agentId: "main", storePath, sessionKey: parentKey })?.owner,
      ).toEqual(assignment);
    },
  );

  it("refreshes consult policy and delivery after an in-process write", async () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
    };
    const runEmbeddedAgent = vi.fn(async () => ({
      payloads: [{ text: "Checked" }],
      meta: { durationMs: 0 },
    }));
    const agentRuntime = { ...createRuntimeAgent(), runEmbeddedAgent };
    const sessionKey = "agent:main:voice-preparation";
    const storePath = state.statePath("consult", "sessions.sqlite");
    const target = { agentId: "main", sessionKey, storePath };
    const consult = () =>
      consultRealtimeVoiceAgent({
        cfg,
        agentRuntime,
        logger: { warn: vi.fn() },
        ...target,
        messageProvider: "voice",
        lane: "talk",
        runIdPrefix: "policy-consult",
        args: { question: "Check this" },
        transcript: [],
        surface: "test voice",
        userLabel: "User",
      });

    await replaceSessionEntry(target, {
      sessionId: "voice-session",
      updatedAt: 1,
      permissionMode: "workspace",
      delivery: normalizeSessionDeliveryState({
        context: { channel: "telegram", to: "chat:initial", accountId: "initial-account" },
      }),
    });
    await expect(consult()).resolves.toEqual({ text: "Checked" });
    expect(runEmbeddedAgent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        permissionMode: "workspace",
        messageProvider: "telegram",
        messageTo: "chat:initial",
        agentAccountId: "initial-account",
      }),
    );

    await replaceSessionEntry(target, {
      sessionId: "voice-session",
      updatedAt: 2,
      permissionMode: "guarded",
      delivery: normalizeSessionDeliveryState({
        context: { channel: "discord", to: "channel:updated", accountId: "updated-account" },
      }),
    });
    await expect(consult()).resolves.toEqual({ text: "Checked" });
    expect(runEmbeddedAgent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        permissionMode: "guarded",
        messageProvider: "discord",
        messageTo: "channel:updated",
        agentAccountId: "updated-account",
      }),
    );
  });

  it("preserves live run identity and source text through transcript storage", async () => {
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
      expect(JSON.stringify(persisted)).toContain(secret);
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

  it.each(
    [
      { parentAgentId: "main", locked: false, contextMode: "isolated" as const },
      { parentAgentId: "main", locked: false, contextMode: "fork" as const },
      { parentAgentId: "other", locked: false, contextMode: "isolated" as const },
      { parentAgentId: "main", locked: true, contextMode: "isolated" as const },
    ].flatMap(({ parentAgentId, locked, contextMode }) =>
      [false, true].map((enabled) => ({ parentAgentId, locked, contextMode, enabled })),
    ),
  )(
    "keeps parent $parentAgentId isolation and routing in its configured store ($contextMode, locked=$locked, creator Lab=$enabled)",
    async ({ parentAgentId, locked, contextMode, enabled }) => {
      const cfg: OpenClawConfig = {
        agents: {
          entries: { main: { workspace: state.workspaceDir }, other: {} },
          defaults: { experimental: { delegatedCreatorAttribution: enabled } },
          ownership: "explicit",
        },
      };
      const runEmbeddedAgent = vi.fn(async (_params: RunEmbeddedAgentParams) => ({
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
          sandboxProvenance: {
            actor: { type: "human", source: "profile", id: "retained-isolation" },
          },
          sandbox: "required",
          modelSelectionLocked: locked,
          delivery: normalizeSessionDeliveryState({
            context: { channel: "discord", to: "channel:synthetic", accountId: "test-account" },
          }),
        },
      );
      if (contextMode === "fork") {
        await appendTranscriptMessage(
          {
            agentId: parentAgentId,
            sessionKey: spawnedBy,
            sessionId: "parent-session",
            storePath: parentStore,
          },
          {
            eventId: "consult-parent-input",
            message: {
              role: "user",
              content: [{ type: "text", text: "Retained consult context" }],
              timestamp: 2,
            },
            now: 2,
          },
        );
      }
      const sessionKey = "agent:main:voice-child";
      const storePath =
        contextMode === "fork" ? parentStore : state.statePath("consult", "sessions.sqlite");
      runEmbeddedAgent.mockImplementation(async () => {
        expect(
          await resolveSandboxRuntimeStatusAsync({
            cfg: { ...cfg, session: { store: storePath } },
            agentId: "main",
            sessionKey,
          }),
        ).toMatchObject({
          sandboxRequired: true,
          isolationSubject: { kind: "profile", profileId: "retained-isolation" },
        });
        return { payloads: [{ text: "Checked" }], meta: { durationMs: 0 } };
      });
      expect(
        await agentRuntime.session.getSessionEntryAsync({
          agentId: parentAgentId,
          sessionKey: spawnedBy,
          storePath: parentStore,
        }),
      ).not.toHaveProperty("sandboxProvenance");
      const prepareToolContext = vi.fn((_entry: SessionEntry) => ({}));
      const consult = consultRealtimeVoiceAgent({
        cfg,
        agentRuntime,
        logger: { warn: vi.fn() },
        agentId: "main",
        sessionKey,
        storePath,
        spawnedBy,
        contextMode,
        prepareToolContext,
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
        createdActor: enabled ? { type: "agent", id: spawnedBy } : createdActor,
        sandboxProvenance: {
          actor: { type: "human", source: "profile", id: "retained-isolation" },
        },
        spawnedBy,
      });
      if (contextMode === "fork") {
        expect(
          loadSessionEntry({ agentId: "main", sessionKey, storePath })?.forkSource?.sessionKey,
        ).toBe(spawnedBy);
      }
      expect(prepareToolContext.mock.calls[0]?.[0]).not.toHaveProperty("sandboxProvenance");
      expect(runEmbeddedAgent.mock.calls[0]?.[0].execSession).not.toHaveProperty(
        "sandboxProvenance",
      );
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
