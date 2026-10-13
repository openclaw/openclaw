import "../../test-utils/prepare-compiled-subprocesses.js";
import { StatementSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { isSessionEntryDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { withIncognitoSessionActor } from "../../config/sessions/session-incognito-binding.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { getOpenIncognitoAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { openIncognitoTestActor } from "../../state/openclaw-agent-execution-incognito.test-support.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import { createSessionsSendTool } from "./sessions-send-tool.js";

const authority = { assertCurrent() {} };
const targetKey = "agent:research:dashboard:durable-target";
const actorKey = "agent:main:dashboard:incognito-send-requester";
const nativeKey = "agent:native:dashboard:incognito-send-requester";
const config = {
  agents: { ownership: "explicit", entries: { main: {}, research: {}, native: {} } },
  session: { mainKey: "main", scope: "per-sender" },
  tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
} satisfies OpenClawConfig;
let state: OpenClawTestState;
let actor: Awaited<ReturnType<typeof openIncognitoTestActor>>;

beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal", label: "sessions-send-incognito" });
  setRuntimeConfigSnapshot(config);
  setActivePluginRegistry(createSessionConversationTestRegistry());
  await replaceSessionEntry(
    { agentId: "research", sessionKey: targetKey },
    { sessionId: "durable-target", lifecycleRevision: "target-generation", updatedAt: 1 },
  );
  await replaceSessionEntry(
    { agentId: "native", sessionKey: nativeKey },
    {
      sessionId: "native-requester",
      lifecycleRevision: "native-generation",
      updatedAt: 1,
      spawnDepth: 1,
      incognito: true,
    },
  );
  actor = await openIncognitoTestActor(state.env, authority);
  await actor.sessions.create(authority, {
    sessionKey: actorKey,
    entry: {
      sessionId: "actor-requester",
      lifecycleRevision: "actor-generation",
      updatedAt: 1,
      spawnDepth: 1,
      incognito: true,
    },
  });
});
afterAll(async () => {
  await actor?.close();
  await state.cleanup();
});

function gateway(beforeAdmission?: () => Promise<void>) {
  return vi
    .fn()
    .mockImplementation(async (request: Parameters<AgentToolGatewayRequestCaller>[0]) => {
      switch (request.method) {
        case "sessions.resolve":
          return { key: targetKey, agentId: "research" };
        case "sessions.list":
          return {
            sessions: [
              { key: targetKey, agentId: "research", sessionId: "durable-target", kind: "direct" },
            ],
          };
        case "sessions.describe":
          return {
            session: {
              key: targetKey,
              agentId: "research",
              sessionId: "durable-target",
              kind: "direct",
            },
          };
        case "agent":
          await beforeAdmission?.();
          request.assertDispatchCurrent?.();
          return { runId: "accepted-private-request", status: "accepted" };
        default:
          throw new Error(`Unexpected Gateway request: ${request.method}`);
      }
    });
}

it.each([
  { owner: "bound", change: "none" },
  { owner: "unbound", change: "none" },
  { owner: "bound", change: "policy" },
  { owner: "bound", change: "incarnation" },
] as const)(
  "checks communication admission for a $owner private requester with $change changed",
  async ({ owner, change }) => {
    const requesterKey = owner === "bound" ? actorKey : nativeKey;
    const requesterAgent = owner === "bound" ? "main" : "native";
    const beforeActors = captureOpenClawAgentDatabaseExecution
      .listIncognito(state.env)
      .map((entry) => entry.identity.incarnation);
    const requesterSql: string[] = [];
    const observers = (["get", "all", "iterate", "run"] as const).map((method) => {
      const original = StatementSync.prototype[method];
      return vi.spyOn(StatementSync.prototype, method).mockImplementation(
        new Proxy(original, {
          apply(target, receiver: StatementSync, args) {
            if (
              isSessionEntryDataSql(receiver.sourceSQL) &&
              JSON.stringify(args).includes(requesterKey)
            ) {
              requesterSql.push(receiver.sourceSQL);
            }
            return Reflect.apply(target, receiver, args);
          },
        }),
      );
    });
    let reachedAdmission = false;
    const callGateway = gateway(async () => {
      reachedAdmission = true;
      if (change !== "none") {
        await replaceSessionEntry(
          { agentId: "main", sessionKey: actorKey },
          {
            sessionId: change === "incarnation" ? "replacement-requester" : "actor-requester",
            lifecycleRevision: "actor-generation",
            updatedAt: 1,
            spawnDepth: 1,
            incognito: true,
            ...(change === "policy" ? { communication: { send: "never" } } : {}),
          },
        );
      }
    });
    const work = new AsyncWorkScope();
    const send = () =>
      createSessionsSendTool({
        config,
        agentId: requesterAgent,
        agentSessionKey: requesterKey,
        agentSessionId: owner === "bound" ? "actor-requester" : "native-requester",
        callGateway,
      }).execute("private-requester-send", {
        sessionKey: targetKey,
        message: "Review this durable task",
        mode: "followup",
        timeoutSeconds: 0,
      });
    try {
      const result = await work.run(() =>
        owner === "bound" ? withIncognitoSessionActor(actor, send) : send(),
      );
      await work.drain();
      expect(reachedAdmission).toBe(true);
      expect(result.details).toMatchObject(
        change === "none"
          ? { status: "accepted", sessionKey: targetKey, delivery: { status: "skipped" } }
          : { status: "error", error: expect.stringMatching(/changed|no longer current/) },
      );
      expect(callGateway.mock.calls.filter(([request]) => request.method === "agent")).toEqual([
        [
          expect.objectContaining({
            params: expect.objectContaining({
              sessionKey: targetKey,
              agentId: "research",
              inputProvenance: expect.objectContaining({
                sourceSessionKey: requesterKey,
                sourceRole: "subagent",
              }),
            }),
          }),
        ],
      ]);
      if (owner === "bound") {
        expect(requesterSql).toEqual([]);
        expect(getOpenIncognitoAgentDatabase("main", actor.path)).toBeUndefined();
      } else {
        expect(
          getOpenIncognitoAgentDatabase(
            "native",
            resolveIncognitoOpenClawAgentSqlitePath({ agentId: "native", env: state.env }),
          ),
        ).toBeDefined();
      }
      expect(
        captureOpenClawAgentDatabaseExecution
          .listIncognito(state.env)
          .map((entry) => entry.identity.incarnation),
      ).toEqual(beforeActors);
    } finally {
      await work.drain();
      observers.forEach((observer) => observer.mockRestore());
      if (change !== "none") {
        await withIncognitoSessionActor(actor, () =>
          replaceSessionEntry(
            { agentId: "main", sessionKey: actorKey },
            {
              sessionId: "actor-requester",
              lifecycleRevision: "actor-generation",
              updatedAt: 1,
              spawnDepth: 1,
              incognito: true,
            },
          ),
        );
      }
    }
  },
);
