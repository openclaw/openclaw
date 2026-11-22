import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { readSessionMessageIdentity } from "../../packages/gateway-client/src/session-projection-message-identity.js";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import type { AgentHarnessResetParams } from "../agents/harness/types.js";
import { resolveAgentRunSessionTarget } from "../agents/run-session-target.js";
import { guardSessionManager } from "../agents/session-tool-result-guard-wrapper.js";
import { SessionManager } from "../agents/sessions/index.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import saveSessionMemory, {
  flushSessionMemoryWritesForTest,
} from "../hooks/bundled/session-memory/handler.js";
import { registerInternalHook, unregisterInternalHook } from "../hooks/internal-hooks.js";
import { resolveMemoryAudienceFromEntry } from "../plugins/memory-audience.js";
import { createRuntimeAgent } from "../plugins/runtime/runtime-agent.js";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "../sessions/model-overrides.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import { retireSessionControllerInput } from "../sessions/session-controller.mailbox-source.js";
import { reserveSessionControllerSource } from "../sessions/session-controller.mailbox.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { consultRealtimeVoiceAgent } from "./agent-consult-runtime.js";

const harnessReset = vi.hoisted(() => vi.fn(async (_params: AgentHarnessResetParams) => {}));
vi.mock("../agents/harness/registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/harness/registry.js")>()),
  resetRegisteredAgentHarnessSessions: harnessReset,
}));

let state: OpenClawTestState;
const checkedResult = () => ({ payloads: [{ text: "Checked" }], meta: { durationMs: 0 } });
beforeEach(async () => {
  harnessReset.mockReset();
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
    const MINUTE = 60_000;
    const noon = new Date(2026, 9, 27, 12).getTime(); // clear of the 04:00 daily boundary
    const daily = { reset: { mode: "daily", atHour: 4 } } as const;
    const stale = noon - 2 * 24 * 60 * MINUTE;
    beforeEach(() => void vi.useFakeTimers({ now: noon, toFake: ["Date"] }));
    afterEach(() => void vi.useRealTimers());

    async function seed(session: OpenClawConfig["session"], at: number, fields = {}) {
      const fixture = createConsultFixture();
      fixture.cfg.session = session;
      const target = {
        agentId: "main",
        sessionKey: "agent:main:voice-reset",
        storePath: state.statePath("consult", "sessions.sqlite"),
      };
      const times = { updatedAt: at, sessionStartedAt: at, lastInteractionAt: at };
      const entry = {
        sessionId: "voice-session",
        lifecycleRevision: "day-one",
        nativeRuntimeConsent: "codex",
        elevatedLevel: "full",
        ...times,
      };
      await replaceSessionEntry(target, { ...entry, ...fields });
      const sessionTarget = { ...target, sessionId: "voice-session" };
      SessionManager.open(sessionTarget, state.workspaceDir).appendMessage(
        makeAgentAssistantMessage({ content: [{ type: "text", text: "earlier voice answer" }] }),
      );
      const seen: Array<{ history: string; prompt: string }> = [];
      fixture.runEmbeddedAgent.mockImplementation(async (params) => {
        expect(params.sessionId).toBe("voice-session");
        const messages = SessionManager.open(
          sessionTarget,
          state.workspaceDir,
        ).buildSessionContext();
        seen.push({ history: JSON.stringify(messages.messages), prompt: params.prompt });
        return checkedResult();
      });
      const revision = () => loadSessionEntry(target)?.lifecycleRevision;
      return { ...fixture, target, seen, revision, run: () => fixture.consult(target) };
    }

    const owed = { updatedAt: 0 }; // a reset deferred by an earlier rollover
    it.each([
      { name: "past the daily boundary", startedAt: stale, reset: true, saved: true },
      {
        name: "past the daily boundary under a short session key",
        key: "voice-reset",
        startedAt: stale,
        reset: true,
        saved: true,
      },
      { name: "within the same day", startedAt: noon - MINUTE, reset: false },
      { name: "with a reset owed", startedAt: noon - MINUTE, fields: owed, reset: true },
      {
        name: "with a reset owed and automatic resets off",
        session: { reset: { mode: "none" } } as const,
        startedAt: noon - MINUTE,
        fields: owed,
        reset: true,
      },
      {
        name: "from a phone with voice resets off",
        session: { ...daily, resetByChannel: { voice: { mode: "none" } } } as const,
        provider: "voice",
        startedAt: stale,
        reset: false,
      },
    ])("applies the session reset before a consult $name", async (row) => {
      const { startedAt, reset } = row;
      registerInternalHook("session:auto-reset", saveSessionMemory);
      onTestFinished(() => unregisterInternalHook("session:auto-reset", saveSessionMemory));
      const { consult, seen, revision, target } = await seed(
        row.session ?? daily,
        startedAt,
        row.fields,
      );
      const liveTranscript = [{ role: "user" as const, text: "CURRENT-CALL: check this" }];
      const sessionKey = row.key ?? target.sessionKey;
      const messageProvider = row.provider ?? "webchat";
      const live = { ...target, sessionKey, messageProvider, transcript: liveTranscript };
      await expect(consult(live)).resolves.toEqual({ text: "Checked" });
      expect(seen[0]?.history.includes("earlier voice answer")).toBe(!reset);
      expect(seen[0]?.prompt).toContain("CURRENT-CALL: check this");
      expect(loadSessionEntry(target)?.sessionId).toBe("voice-session");
      const after = revision();
      expect(after === "day-one").toBe(!reset);
      // Grants of the ended conversation do not carry into the new one.
      const { nativeRuntimeConsent, elevatedLevel } = loadSessionEntry(target) ?? {};
      expect([nativeRuntimeConsent, elevatedLevel]).toEqual(
        reset ? [undefined, undefined] : ["codex", "full"],
      );
      // The next consult continues the rolled-over session instead of resetting again.
      await expect(consult({ ...target, sessionKey, messageProvider })).resolves.toEqual({
        text: "Checked",
      });
      // Native harness conversations (ACP) restart with the session, under its qualified key.
      expect(harnessReset.mock.calls.map(([call]) => call)).toEqual(
        reset
          ? [
              expect.objectContaining({
                sessionKey: target.sessionKey,
                sessionId: "voice-session",
                reason: row.fields ? "unknown" : "daily",
              }),
            ]
          : [],
      );
      expect(revision()).toBe(after);
      // Session memory saves the ended day, including what the reset dropped from view.
      await flushSessionMemoryWritesForTest();
      const memoryDir = path.join(state.workspaceDir, "memory");
      const files = await fs.readdir(memoryDir).catch(() => []);
      expect(files).toHaveLength(row.saved ? 1 : 0);
      if (row.saved) {
        const memory = await fs.readFile(path.join(memoryDir, files[0]!), "utf8");
        expect(memory).toContain("earlier voice answer");
      }
    });

    it("keeps a blocked stale session unchanged for admission to reject", async () => {
      const { revision, run, runEmbeddedAgent } = await seed(daily, stale, { archivedAt: noon });
      await expect(run()).rejects.toThrow("is archived");
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
      expect(revision()).toBe("day-one");
    });

    it("preserves earlier queued input when a direct consult resets the session", async () => {
      const { revision, runEmbeddedAgent, target, consult } = await seed(daily, stale);
      const input = reserveSessionControllerSource(target.sessionKey, {
        policy: { mode: "followup" },
        target: captureSessionTarget({ ...target, storeScope: target.storePath }),
        adapter: { signal: new AbortController().signal },
      });
      try {
        const result = await consult(target);
        expect(result).toEqual({ text: "Checked" });
        expect(input.abortSignal.aborted).toBe(false);
        expect(runEmbeddedAgent).toHaveBeenCalledTimes(1);
        expect(revision()).not.toBe("day-one");
      } finally {
        retireSessionControllerInput(input);
      }
    });

    it.each(["cancels", "loses its authority"] as const)(
      "leaves the session untouched when the caller %s during preparation",
      async (loss) => {
        const { agentRuntime, consult, revision, runEmbeddedAgent, target } = await seed(
          daily,
          stale,
        );
        const controller = new AbortController();
        let revoked = false;
        const read = agentRuntime.session.getSessionEntryAsync;
        agentRuntime.session = {
          ...agentRuntime.session,
          getSessionEntryAsync: async (lookup) =>
            read(lookup).finally(() =>
              loss === "cancels" ? controller.abort(new Error("caller closed")) : (revoked = true),
            ),
        };
        const assertSourceCurrent = () => {
          if (revoked) {
            throw new Error("caller closed");
          }
        };
        const result = consult({ ...target, abortSignal: controller.signal, assertSourceCurrent });
        await expect(result).rejects.toThrow("caller closed");
        // A revoked caller fails on its authority; its request is not cancelled.
        expect(controller.signal.aborted).toBe(loss === "cancels");
        expect(runEmbeddedAgent).not.toHaveBeenCalled();
        expect(harnessReset).not.toHaveBeenCalled();
        expect(revision()).toBe("day-one");
      },
    );

    it.each(["is cancelled", "closes its call"] as const)(
      "finishes a started reset when the caller %s during native cleanup",
      async (loss) => {
        const { consult, revision, runEmbeddedAgent, target } = await seed(daily, stale);
        const controller = new AbortController();
        let closed = false;
        harnessReset.mockImplementationOnce(async () => {
          if (loss === "is cancelled") {
            controller.abort(new Error("caller closed"));
          } else {
            closed = true;
          }
        });
        const assertSourceCurrent = () => {
          if (closed) {
            throw new Error("caller closed");
          }
        };
        const result = consult({ ...target, abortSignal: controller.signal, assertSourceCurrent });
        await expect(result).rejects.toThrow("caller closed");
        expect(harnessReset).toHaveBeenCalledTimes(1);
        expect(runEmbeddedAgent).not.toHaveBeenCalled();
        expect(revision()).not.toBe("day-one");
      },
    );

    it("leaves a session its Access program refuses to the caller untouched", async () => {
      const { consult, revision, runEmbeddedAgent, target } = await seed(daily, stale, {
        cyberAccessProgram: "daybreak_blue",
      });
      const operatorAuthority = createAdmittedRunOperatorAuthority({
        profileId: "restricted-role",
        scopes: ["operator.write"],
        rolePolicy: { sessionAccessCap: "none", sandboxRequired: false, agents: "*" },
        assertCurrent() {},
      });
      await expect(consult({ ...target, operatorAuthority })).rejects.toThrow("Access level");
      expect(harnessReset).not.toHaveBeenCalled();
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
      expect(revision()).toBe("day-one");
    });

    it("counts each consult as activity for idle reset", async () => {
      const { revision, run } = await seed({ reset: { mode: "idle", idleMinutes: 5 } }, noon);
      // A consult every four minutes never goes idle; ten quiet minutes later one starts fresh.
      for (const minute of [0, 4, 8, 12, 22]) {
        vi.setSystemTime(noon + minute * MINUTE);
        expect(revision() === "day-one").toBe(true);
        await expect(run()).resolves.toEqual({ text: "Checked" });
      }
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
