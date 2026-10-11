import "../../test-utils/prepare-compiled-subprocesses.js";
import { StatementSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { isSessionEntryDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import {
  runWithSessionActorStorage,
  type SessionActorStorageBinding,
} from "../../config/sessions/session-actor-storage-binding.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import { createSessionsSendTool } from "./sessions-send-tool.js";

const authority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };
const targetKey = "agent:research:dashboard:durable-target";
const actorKey = "agent:main:dashboard:incognito-send-requester";
const nativeKey = "agent:native:dashboard:incognito-send-requester";
const config = {
  agents: { ownership: "explicit", entries: { main: {}, research: {}, native: {} } },
  session: { mainKey: "main", scope: "per-sender" },
  tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
} satisfies OpenClawConfig;
let state: OpenClawTestState;
let actor: SessionActorStorageBinding;
const owners: ReturnType<typeof memorySessionActorOwners.get>[] = [];
const handles: SessionActorStorageBinding[] = [];

beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal", label: "sessions-send-incognito" });
  setRuntimeConfigSnapshot(config);
  setActivePluginRegistry(createSessionConversationTestRegistry());
  await replaceSessionEntry(
    { agentId: "research", sessionKey: targetKey },
    { sessionId: "durable-target", lifecycleRevision: "target-generation", updatedAt: 1 },
  );
  for (const [agentId, sessionKey, sessionId] of [
    ["main", actorKey, "actor-requester"],
    ["native", nativeKey, "native-requester"],
  ] as const) {
    const owner = memorySessionActorOwners.get({
      agentId,
      path: resolveIncognitoOpenClawAgentSqlitePath({ agentId, env: state.env }),
    });
    owners.push(owner);
    const handle = await owner.acquire({ database: owner.identity, sessionKey }, lifetime);
    const binding = { actor: handle, authority, agentId, path: owner.path };
    handles.push(binding);
    expect(
      await handle.storage!.mutate(
        {
          type: "session.entry.create",
          input: {
            entry: {
              sessionId,
              lifecycleRevision: "actor-generation",
              updatedAt: 1,
              spawnDepth: 1,
              incognito: true,
            },
          },
        },
        authority,
      ),
    ).toMatchObject({ kind: "committed" });
    if (agentId === "main") {
      actor = binding;
    }
  }
});
afterAll(async () => {
  for (const binding of handles) {
    await binding.actor.release();
  }
  for (const owner of owners) {
    memorySessionActorOwners.closeDatabase(owner);
  }
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
    const beforeOwners = memorySessionActorOwners.list();
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
        owner === "bound" ? runWithSessionActorStorage(actor, send) : send(),
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
      expect(requesterSql).toEqual([]);
      expect(memorySessionActorOwners.list()).toEqual(beforeOwners);
    } finally {
      await work.drain();
      observers.forEach((observer) => observer.mockRestore());
      if (change !== "none") {
        await runWithSessionActorStorage(actor, () =>
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
