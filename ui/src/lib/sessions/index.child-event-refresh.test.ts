// @vitest-environment node
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

const parent = "agent:main:parent";
const known: GatewaySessionRow = {
  key: "agent:worker:subagent:known",
  sessionId: "known-session",
  kind: "direct",
  spawnedBy: parent,
  updatedAt: 1,
};
const added: GatewaySessionRow = {
  key: "agent:research:subagent:added",
  sessionId: "added-session",
  kind: "direct",
  parentSessionKey: parent,
  updatedAt: 2,
};

it.each([
  {
    name: "unrelated agent activity",
    payload: { sessionKey: "agent:research:other", reason: "update" },
    refresh: false,
  },
  {
    name: "unrelated same-agent root",
    payload: { sessionKey: "agent:main:other", reason: "update" },
    refresh: false,
  },
  {
    name: "cross-agent child creation",
    payload: { sessionKey: added.key, parentSessionKey: parent, reason: "create" },
    refresh: true,
    rows: [added],
  },
  {
    name: "new runtime-controlled child",
    payload: { sessionKey: added.key, controlOwnerSessionKey: parent, reason: "create" },
    refresh: true,
    rows: [added],
  },
  {
    name: "new persisted child",
    payload: {
      sessionKey: added.key,
      session: { ...added, parentSessionKey: undefined, spawnedBy: parent },
      reason: "create",
    },
    refresh: true,
    rows: [added],
  },
  {
    name: "known child deletion before list reconciliation",
    payload: { sessionKey: known.key, sessionId: known.sessionId, reason: "delete" },
    refresh: true,
    rows: [],
  },
  {
    name: "key-only lifecycle deletion",
    payload: { sessionKey: known.key, reason: "delete" },
    refresh: true,
    rows: [],
  },
  {
    name: "known child moved to another parent",
    payload: {
      sessionKey: known.key,
      session: { ...known, spawnedBy: "agent:other:parent", updatedAt: 2 },
      reason: "move",
    },
    refresh: true,
    rows: [],
  },
  { name: "parent Swarm change", payload: { sessionKey: parent, reason: "swarm" }, refresh: true },
  {
    name: "parent change for an explicitly cross-agent child query",
    payload: { sessionKey: parent, reason: "swarm" },
    queryAgent: "worker",
    refresh: true,
  },
  { name: "global membership invalidation", payload: { reason: "delete" }, refresh: true },
  {
    name: "sparse event for an unloaded child page",
    payload: { sessionKey: "agent:research:unloaded", reason: "delete" },
    refresh: true,
    incomplete: true,
  },
  {
    name: "off-page child reparented outside an incomplete window",
    payload: {
      sessionKey: "agent:research:off-page-child",
      parentSessionKey: "agent:research:parent",
      reason: "move",
    },
    refresh: true,
    incomplete: true,
  },
  {
    name: "unrelated explicit lineage in a complete window",
    payload: {
      sessionKey: "agent:research:other",
      parentSessionKey: "agent:research:parent",
      reason: "create",
    },
    refresh: false,
  },
])(
  "refreshes a parent-scoped child query only for $name",
  async ({ payload, refresh, rows, incomplete, queryAgent }) => {
    vi.useFakeTimers();
    let currentRows = [known];
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      const children = isRecord(params) && params.spawnedBy === parent;
      return {
        ...sessionsResult(children ? currentRows : [], 1),
        hasMore: children && incomplete === true,
        totalCount: children && incomplete ? 10_001 : children ? currentRows.length : 0,
      };
    });
    const { gateway, emitEvent } = createGatewayHarness(createTestGatewayClient(request));
    const sessions = createTestSessionCapability(gateway);
    const query = {
      spawnedBy: parent,
      limit: 10_000,
      includeGlobal: false,
      includeUnknown: false,
      ...(queryAgent ? { agentId: queryAgent } : {}),
    };
    const observer = sessions.observeList(query, () => undefined);
    try {
      await sessions.refresh({ agentId: "main", force: true });
      await observer.refresh();
      request.mockClear();
      currentRows = rows ?? currentRows;
      emitEvent({ type: "event", event: "sessions.changed", payload });
      await vi.advanceTimersByTimeAsync(250);
      const childRequests = request.mock.calls.filter(
        ([, params]) => isRecord(params) && params.spawnedBy === parent,
      );
      expect(childRequests).toHaveLength(refresh ? 1 : 0);
      if (refresh) {
        expect(sessions.listSnapshot(query).result?.sessions.map((entry) => entry.key)).toEqual(
          currentRows.map((entry) => entry.key),
        );
      }
    } finally {
      observer.dispose();
      sessions.dispose();
      vi.useRealTimers();
    }
  },
);
