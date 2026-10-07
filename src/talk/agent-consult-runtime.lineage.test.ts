import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveMemoryAudienceFromEntry } from "../plugins/memory-audience.js";
import { createRuntimeAgent } from "../plugins/runtime/runtime-agent.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { consultRealtimeVoiceAgent } from "./agent-consult-runtime.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "voice-consult-lineage" });
});
afterEach(async () => {
  await state.cleanup();
});

it.each([
  { chatType: "direct", senderIsOwner: true, contextMode: "isolated", audience: "owner-private" },
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
