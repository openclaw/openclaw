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
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import { reserveSessionControllerSource } from "../sessions/session-controller.mailbox.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { consultRealtimeVoiceAgent } from "./agent-consult-runtime.js";

let state: OpenClawTestState;
const checkedResult = () => ({ payloads: [{ text: "Checked" }], meta: { durationMs: 0 } });
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "voice-consult-store" });
});
afterEach(async () => {
  await state.cleanup();
});

function createConsultFixture() {
  const cfg: OpenClawConfig = {
    agents: { entries: { main: { workspace: state.workspaceDir } } },
  };
  const runEmbeddedAgent = vi.fn(async (_params: RunEmbeddedAgentParams) => checkedResult());
  const agentRuntime = { ...createRuntimeAgent(), runEmbeddedAgent };
  const consult = (params: Partial<Parameters<typeof consultRealtimeVoiceAgent>[0]>) =>
    consultRealtimeVoiceAgent({
      cfg,
      agentRuntime,
      logger: { warn: vi.fn() },
      agentId: "main",
      sessionKey: "agent:main:voice-consult",
      messageProvider: "webchat",
      lane: "talk",
      runIdPrefix: "test-consult",
      args: { question: "Check this" },
      transcript: [],
      surface: "test voice",
      userLabel: "User",
      ...params,
    });
  return { cfg, agentRuntime, runEmbeddedAgent, consult };
}

describe("voice consult concrete store ownership", () => {
  it("refreshes consult policy and delivery after an in-process write", async () => {
    const { runEmbeddedAgent, consult } = createConsultFixture();
    const sessionKey = "agent:main:voice-preparation";
    const storePath = state.statePath("consult", "sessions.sqlite");
    const target = { agentId: "main", sessionKey, storePath };
    const run = () => consult({ ...target, messageProvider: "voice" });

    const revisions = [
      ["workspace", "telegram", "chat:initial", "initial-account"],
      ["guarded", "discord", "channel:updated", "updated-account"],
    ] as const;
    for (const [revision, [permissionMode, channel, to, accountId]] of revisions.entries()) {
      await replaceSessionEntry(target, {
        sessionId: "voice-session",
        updatedAt: revision + 1,
        permissionMode,
        delivery: normalizeSessionDeliveryState({ context: { channel, to, accountId } }),
      });
      await expect(run()).resolves.toEqual({ text: "Checked" });
      expect(runEmbeddedAgent.mock.calls[revision]?.[0]).toMatchObject({
        permissionMode,
        messageProvider: channel,
        messageTo: to,
        agentAccountId: accountId,
      });
    }
  });

  describe("configured session reset", () => {
    const MINUTE_MS = 60 * 1000;
    // Midday keeps every fixture clear of the 04:00 daily boundary.
    const noon = new Date(2026, 9, 27, 12).getTime();
    beforeEach(() => {
      vi.useFakeTimers({ now: noon, toFake: ["Date"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    async function seedVoiceSession(
      session: OpenClawConfig["session"],
      startedAt: number,
      fields: Record<string, unknown> = {},
    ) {
      const fixture = createConsultFixture();
      fixture.cfg.session = session;
      const storePath = state.statePath("consult", "sessions.sqlite");
      const target = { agentId: "main", sessionKey: "agent:main:voice-reset", storePath };
      await replaceSessionEntry(target, {
        sessionId: "voice-session",
        lifecycleRevision: "day-one",
        updatedAt: startedAt,
        sessionStartedAt: startedAt,
        lastInteractionAt: startedAt,
        ...fields,
      });
      const sessionTarget = { ...target, sessionId: "voice-session" };
      SessionManager.open(sessionTarget, state.workspaceDir).appendMessage(
        makeAgentAssistantMessage({ content: [{ type: "text", text: "earlier voice answer" }] }),
      );
      const histories: string[] = [];
      fixture.runEmbeddedAgent.mockImplementation(async (params) => {
        expect(params.sessionId).toBe("voice-session");
        histories.push(
          JSON.stringify(
            SessionManager.open(sessionTarget, state.workspaceDir).buildSessionContext().messages,
          ),
        );
        return checkedResult();
      });
      const revision = () => loadSessionEntry(target)?.lifecycleRevision;
      return { ...fixture, target, histories, revision, run: () => fixture.consult(target) };
    }

    it.each([
      { name: "past the daily boundary", startedAt: noon - 2 * 24 * 60 * MINUTE_MS, rolled: true },
      { name: "within the same day", startedAt: noon - MINUTE_MS, rolled: false },
    ])("applies the daily reset before a consult $name", async ({ startedAt, rolled }) => {
      const { histories, revision, run, target } = await seedVoiceSession(
        { reset: { mode: "daily", atHour: 4 } },
        startedAt,
      );

      await expect(run()).resolves.toEqual({ text: "Checked" });
      expect(histories[0]?.includes("earlier voice answer")).toBe(!rolled);
      expect(loadSessionEntry(target)?.sessionId).toBe("voice-session");
      const rolledRevision = revision();
      expect(rolledRevision === "day-one").toBe(!rolled);

      // The next consult continues the rolled-over session instead of resetting again.
      await expect(run()).resolves.toEqual({ text: "Checked" });
      expect(revision()).toBe(rolledRevision);
    });

    it.each([
      { name: "a reset", startedAt: noon - 2 * 24 * 60 * MINUTE_MS, reset: true },
      { name: "no reset", startedAt: noon - MINUTE_MS, reset: false },
    ])(
      "replaces history quoted before $name in the consult prompt",
      async ({ startedAt, reset }) => {
        const { runEmbeddedAgent, consult, target } = await seedVoiceSession(
          { reset: { mode: "daily", atHour: 4 } },
          startedAt,
        );
        const prompts: string[] = [];
        runEmbeddedAgent.mockImplementation(async (params) => {
          prompts.push(params.prompt);
          return checkedResult();
        });
        const onSessionReset = vi.fn(() => []);

        await expect(
          consult({
            ...target,
            transcript: [{ role: "user", text: "Quoted call history: PELICAN-DAY1" }],
            onSessionReset,
          }),
        ).resolves.toEqual({ text: "Checked" });

        expect(onSessionReset).toHaveBeenCalledTimes(reset ? 1 : 0);
        expect(prompts[0]?.includes("PELICAN-DAY1")).toBe(!reset);
      },
    );

    it("keeps a blocked stale session unchanged for admission to reject", async () => {
      const { revision, run, runEmbeddedAgent } = await seedVoiceSession(
        { reset: { mode: "daily", atHour: 4 } },
        noon - 2 * 24 * 60 * MINUTE_MS,
        { archivedAt: noon - MINUTE_MS },
      );

      await expect(run()).rejects.toThrow("is archived");
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
      expect(revision()).toBe("day-one");
    });

    it("keeps the browser's reserved consult input across the reset", async () => {
      const { revision, runEmbeddedAgent, target, consult } = await seedVoiceSession(
        { reset: { mode: "daily", atHour: 4 } },
        noon - 2 * 24 * 60 * MINUTE_MS,
      );
      // Browser Talk reserves its controller input before entering the consult runtime and passes
      // that input's signal as the consult's abort signal (client-gateway-control.ts).
      const adapter = new AbortController();
      const input = reserveSessionControllerSource(target.sessionKey, {
        policy: { mode: "followup" },
        target: captureSessionTarget({
          storeScope: target.storePath,
          sessionKey: target.sessionKey,
          agentId: target.agentId,
        }),
        adapter: { signal: adapter.signal },
      });

      await expect(consult({ ...target, abortSignal: input.abortSignal })).resolves.toEqual({
        text: "Checked",
      });
      expect(input.abortSignal.aborted).toBe(false);
      expect(runEmbeddedAgent).toHaveBeenCalledTimes(1);
      expect(revision()).not.toBe("day-one");
    });

    it.each([
      { name: "keeps its authority", revoke: false },
      { name: "loses its authority", revoke: true },
    ])("resets only while the caller $name through the commit", async ({ revoke }) => {
      const { agentRuntime, consult, revision, runEmbeddedAgent, target } = await seedVoiceSession(
        { reset: { mode: "daily", atHour: 4 } },
        noon - 2 * 24 * 60 * MINUTE_MS,
      );
      let revoked = false;
      const read = agentRuntime.session.getSessionEntryAsync;
      agentRuntime.session = {
        ...agentRuntime.session,
        // Operator or device revocation lands while the consult prepares its reset.
        getSessionEntryAsync: async (lookup) => {
          const entry = await read(lookup);
          revoked = revoke;
          return entry;
        },
      };
      const assertSourceCurrent = () => {
        if (revoked) {
          throw new Error("Talk caller source authority is no longer active");
        }
      };

      const result = consult({ ...target, assertSourceCurrent });

      if (revoke) {
        await expect(result).rejects.toThrow("no longer active");
        expect(runEmbeddedAgent).not.toHaveBeenCalled();
        expect(revision()).toBe("day-one");
      } else {
        await expect(result).resolves.toEqual({ text: "Checked" });
        expect(revision()).not.toBe("day-one");
      }
    });

    it("leaves the session untouched when the caller cancels during preparation", async () => {
      const { agentRuntime, consult, revision, runEmbeddedAgent, target } = await seedVoiceSession(
        { reset: { mode: "daily", atHour: 4 } },
        noon - 2 * 24 * 60 * MINUTE_MS,
      );
      const controller = new AbortController();
      const read = agentRuntime.session.getSessionEntryAsync;
      agentRuntime.session = {
        ...agentRuntime.session,
        getSessionEntryAsync: async (lookup) => {
          const entry = await read(lookup);
          controller.abort(new Error("caller closed"));
          return entry;
        },
      };

      await expect(consult({ ...target, abortSignal: controller.signal })).rejects.toThrow(
        "caller closed",
      );
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
      expect(revision()).toBe("day-one");
    });

    it("counts each consult as activity for idle reset", async () => {
      const { revision, run } = await seedVoiceSession(
        { reset: { mode: "idle", idleMinutes: 5 } },
        noon - MINUTE_MS,
      );

      // Continuous voice use, a consult every four minutes, never goes idle.
      for (let minute = 0; minute <= 12; minute += 4) {
        vi.setSystemTime(noon + minute * MINUTE_MS);
        await expect(run()).resolves.toEqual({ text: "Checked" });
      }
      expect(revision()).toBe("day-one");

      // Ten quiet minutes later the next consult starts fresh.
      vi.setSystemTime(noon + 22 * MINUTE_MS);
      await expect(run()).resolves.toEqual({ text: "Checked" });
      expect(revision()).not.toBe("day-one");
    });
  });

  it("preserves live run identity and source text through transcript storage", async () => {
    const runIdPrefix = "zoom-meetings:zoom_meeting_11111111-2222-4333-8444-123456789012";
    const { cfg, runEmbeddedAgent, consult } = createConsultFixture();
    const runIds: string[] = [];
    const secret = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    runEmbeddedAgent.mockImplementation(async (params) => {
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
      return checkedResult();
    });
    for (let turn = 0; turn < 2; turn++) {
      await expect(
        consult({
          sessionKey: "agent:main:voice-identity",
          runIdPrefix,
          onRunStarted: ({ runId }) => void runIds.push(runId),
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
      const { cfg, agentRuntime, runEmbeddedAgent, consult } = createConsultFixture();
      cfg.agents = {
        entries: { main: { workspace: state.workspaceDir }, other: {} },
        ownership: "explicit",
      };
      const spawnedBy = `agent:${parentAgentId}:parent`;
      const parentStore = agentRuntime.session.resolveStorePath(cfg.session?.store, {
        agentId: parentAgentId,
      });
      const createdActor = { type: "human", source: "profile", id: "parent-creator" } as const;
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
      const target = { agentId: "main", sessionKey, storePath };
      const result = consult({ ...target, spawnedBy, contextMode: "isolated" });
      if (locked) {
        await expect(result).rejects.toThrow(MODEL_SELECTION_LOCKED_MESSAGE);
        expect(runEmbeddedAgent).not.toHaveBeenCalled();
        expect(loadSessionEntry(target)).toBeUndefined();
        return;
      }
      await expect(result).resolves.toEqual({ text: "Checked" });
      const child = loadSessionEntry(target);
      expect(child).toMatchObject({ sandbox: "required", createdActor, spawnedBy });
      expect(runEmbeddedAgent.mock.calls[0]?.[0]).toMatchObject({
        messageProvider: "discord",
        messageTo: "channel:synthetic",
        agentAccountId: "test-account",
        sessionTarget: target,
      });
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
    const { cfg, agentRuntime, consult } = createConsultFixture();
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
      consult({
        sessionKey,
        spawnedBy: rootKey,
        senderIsOwner,
        contextMode,
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
