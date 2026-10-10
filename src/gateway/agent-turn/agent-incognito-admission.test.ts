import "../../test-utils/prepare-compiled-subprocesses.js";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createDeferred, awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { withIncognitoSessionActor } from "../../config/sessions/session-incognito-binding.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import * as voiceRouting from "../../infra/voicewake-routing.js";
import { openIncognitoTestActor } from "../../state/openclaw-agent-execution-incognito.test-support.js";
import { agentRunHandler } from "../server-methods/agent-run-handler.js";
import { prepareAgentSession } from "../server-methods/agent-session-prepare.js";
import { agentHandlers } from "../server-methods/agent.js";
import { prepareAgentContentPhase } from "./agent-content-phase.js";
import * as agentJobs from "./agent-job.js";
import { setGatewayDedupeEntry } from "./agent-job.js";
import { prepareAgentRequestRouting } from "./agent-request-routing.js";
import { createTrackedDispatch } from "./agent-run-dispatch.test-support.js";
import {
  captureAgentSessionSource,
  prepareAgentRelatedSessionSource,
} from "./agent-session-source.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {} };
const cfg = { agents: { entries: { main: {} } } };
let actor: Awaited<ReturnType<typeof openIncognitoTestActor>>;
beforeAll(async () => {
  actor = await openIncognitoTestActor(
    { OPENCLAW_STATE_DIR: dirs.make("agent-incognito-") },
    authority,
  );
});
afterAll(async () => actor?.close());

it("rejects a persisted collector through the public agent handler without host session SQL", async () => {
  const sessionKey = "agent:main:subagent:incognito-collector";
  await actor.sessions.create(authority, {
    sessionKey,
    entry: { sessionId: "collector", updatedAt: 1, incognito: true, swarmCollector: true },
  });
  const { context } = createTrackedDispatch();
  context.getRuntimeConfig = () => cfg;
  const respond = vi.fn();
  const sql = observeHostDataSql();
  try {
    await withIncognitoSessionActor(actor, () =>
      agentRunHandler({
        params: { message: "continue", sessionKey, idempotencyKey: "collector-start" },
        context,
        respond,
        client: null,
        isWebchatConnect: () => false,
      } as never),
    );
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "active swarm collector sessions require swarmCollector=true",
      }),
      undefined,
    );
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }
});

it("binds approval and dedupe to the same actor read while a missing target stays uncreated", async () => {
  await withIncognitoSessionActor(actor, async () => {
    const source = captureAgentSessionSource();
    const sessionKey = "agent:main:dashboard:incognito-missing";
    const { context } = createTrackedDispatch();
    const bind = vi.fn();
    try {
      const result = await prepareAgentRequestRouting({
        request: { message: "hello", sessionKey, idempotencyKey: "missing" },
        cfg,
        isRawModelRun: false,
        runId: "missing",
        agentDedupeKeys: ["missing"],
        context,
        respond: vi.fn(),
        reserveDedupe: vi.fn(),
        bindDedupeSessionTarget: bind,
        clearDedupe: vi.fn(),
        sessionSource: source,
      });
      expect(result?.requestedSessionKey).toBe(sessionKey);
      expect(bind).toHaveBeenCalledWith({ sessionKey, agentId: "main", sessionId: undefined });
      expect(source.readCurrent(sessionKey, "main")).toBeUndefined();
      expect((await actor.sessions.read(authority, { sessionKey })).entry).toBeUndefined();
    } finally {
      await source.release();
    }
  });
});

it.each([false, true])(
  "reuses a failed actor candidate only with transcript presence=%s",
  async (present) => {
    const sessionKey = `agent:main:dashboard:incognito-failed-${present}`;
    const sessionId = `failed-${present}`;
    await actor.sessions.create(authority, {
      sessionKey,
      entry: { sessionId, updatedAt: Date.now(), status: "failed", incognito: true },
    });
    if (present) {
      await actor.sessions.transcript(authority, {
        type: "session.message.append",
        input: {
          sessionKey,
          sessionId,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "retained" }],
            timestamp: 1,
          },
        },
      });
    }
    await withIncognitoSessionActor(actor, async () => {
      const source = captureAgentSessionSource();
      const sql = observeHostDataSql();
      try {
        const prepared = await prepareAgentSession({
          cfg,
          requestedSessionKey: sessionKey,
          agentId: "main",
          request: { message: "retry", sessionKey, idempotencyKey: "retry" },
          canUseCronRunContinuation: false,
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
          respond: vi.fn(),
          sessionSource: source,
        });
        expect(prepared).toBeDefined();
        expect(prepared?.isNewSession).toBe(!present);
        expect(prepared?.sessionId === sessionId).toBe(present);
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
        await source.release();
      }
    });
  },
);

it("revokes inherited group facts when the retained parent changes", async () => {
  const sessionKey = "agent:main:dashboard:incognito-parent";
  await actor.sessions.create(authority, {
    sessionKey,
    entry: { sessionId: "parent", updatedAt: 1, incognito: true, groupId: "group-a" },
  });
  await withIncognitoSessionActor(actor, async () => {
    const parent = await prepareAgentRelatedSessionSource({
      cfg,
      sessionKey,
      fields: ["sessionId", "lifecycleRevision", "groupId", "groupChannel", "space"],
    });
    try {
      expect(parent?.entry?.groupId).toBe("group-a");
      await patchSessionEntryCore(
        { agentId: actor.agentId, storePath: actor.path, sessionKey },
        () => ({ groupId: "group-b" }),
      );
      expect(() => parent?.source()).toThrow("Related session changed");
    } finally {
      await parent?.release();
    }
  });
});

it("keeps scoped agent.wait authorization current before and after the wait", async () => {
  const sessionKey = "agent:main:dashboard:incognito-wait";
  const sessionId = "wait-session";
  await actor.sessions.create(authority, {
    sessionKey,
    entry: { sessionId, updatedAt: 1, incognito: true },
  });
  const { context } = createTrackedDispatch();
  context.getRuntimeConfig = () => ({
    ...cfg,
    gateway: {
      roles: {
        default: "reader",
        definitions: {
          reader: { agents: ["main"], scopes: ["operator.read"], sessions: { others: "none" } },
        },
      },
    },
  });
  const client = {
    authenticatedUserProfile: {
      profileId: "scoped-reader",
      displayName: "Reader",
      hasAvatar: false,
      updatedAt: 1,
    },
    connect: { scopes: ["operator.read"] },
  };
  const runId = "actor-wait-run";
  setGatewayDedupeEntry({
    dedupe: context.dedupe,
    key: `agent:${runId}`,
    entry: { ts: Date.now(), ok: true, payload: { runId, status: "ok" } },
    session: {
      sessionKey,
      sessionId,
      agentId: "main",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
    },
  });
  await withIncognitoSessionActor(actor, async () => {
    const denied = vi.fn();
    await agentHandlers["agent.wait"]({
      params: { runId },
      context,
      client,
      respond: denied,
      isWebchatConnect: () => false,
    } as never);
    expect(denied).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "agent run was not found" }),
    );
    client.connect.scopes = ["operator.admin"];
    const entered = createDeferred();
    const resume = createDeferred();
    const original = agentJobs.waitForAgentJob;
    const observe = vi.spyOn(agentJobs, "waitForAgentJob").mockImplementation(async (...args) => {
      const result = await original(...args);
      entered.resolve();
      await resume.promise;
      return result;
    });
    const respond = vi.fn();
    const waiting = agentHandlers["agent.wait"]({
      params: { runId },
      context,
      client,
      respond,
      isWebchatConnect: () => false,
    } as never);
    try {
      await awaitGateBeforeSettlement(entered.promise, waiting, "agent.wait skipped the job owner");
      client.connect.scopes = ["operator.read"];
      resume.resolve();
      await waiting;
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: "agent run was not found" }),
      );
    } finally {
      resume.resolve();
      await waiting;
      observe.mockRestore();
    }
  });
});

it.each(["explicit", "configured"] as const)(
  "routes voice wake from the %s target without reading session data",
  async (mode) => {
    const explicitKey = "agent:main:dashboard:incognito-voice-explicit";
    const routedKey = "agent:main:dashboard:incognito-voice-routed";
    const requestedKey = mode === "explicit" ? explicitKey : "agent:main:main";
    const { context } = createTrackedDispatch();
    context.getRuntimeConfig = () => cfg;
    const route = vi.spyOn(voiceRouting, "loadVoiceWakeRoutingConfig").mockResolvedValue({
      version: 1,
      defaultTarget: { mode: "current" },
      routes: [{ trigger: "wake", target: { sessionKey: routedKey } }],
      updatedAtMs: 1,
    });
    const respond = vi.fn();
    const sql = observeHostDataSql();
    try {
      const result = await withIncognitoSessionActor(actor, () =>
        prepareAgentContentPhase({
          request: {
            message: "voice request",
            sessionKey: requestedKey,
            voiceWakeTrigger: "wake",
            idempotencyKey: `voice-${mode}`,
          },
          cfg,
          context,
          respond,
          isRawModelRun: false,
          normalizedAttachments: [],
          requestedSessionKeyRaw: requestedKey,
          requestedSessionKey: requestedKey,
          agentId: "main",
          knownAgents: ["main"],
        }),
      );
      expect(respond).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        agentId: "main",
        requestedSessionKey: mode === "explicit" ? explicitKey : routedKey,
      });
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
      route.mockRestore();
    }
  },
);
