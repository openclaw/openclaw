import { afterEach, expect, it, vi } from "vitest";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.native.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { retainSessionListForegroundWork } from "../session-projection-work.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { sessionByKeyReadHandlers } from "./sessions-read-by-key.js";
import {
  identifiedClient,
  initializeSessionReadContext,
  listSessions,
  requestContext,
  sessionReadHandlers,
} from "./sessions-read-cache.test-support.js";

afterEach(() => vi.restoreAllMocks());

it("pages and searches archived sessions without materializing excluded candidates", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = {
      agents: {
        defaults: { model: { primary: "anthropic/claude-sonnet-4-5" } },
        list: [{ id: "main", default: true }],
      },
    };
    setRuntimeConfigSnapshot(cfg);
    for (let index = 0; index < 7; index++) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: `agent:main:row-${index}` },
        {
          sessionId: `row-${index}`,
          updatedAt: index + 1,
          ...(index % 2 === 0 ? { archivedAt: 1 } : {}),
        },
      );
    }
    const release = retainSessionListForegroundWork();
    const context = requestContext(cfg);
    const client = identifiedClient("archive-viewer");
    await initializeSessionReadContext(context);
    const projection = getSessionRowProjection(context)!;
    const list = (request: Parameters<typeof listSessions>[0]["request"]) =>
      listSessions({ context, client, request });
    try {
      await projection.ensureMaterialized();
      expect(projection.materializedCount).toBe(3);
      const first = await list({ archived: true, limit: 2 });
      expect(first).toMatchObject({ count: 2, totalCount: 4, nextOffset: 2 });
      expect(first.sessions.map((row) => row.sessionId)).toEqual(["row-6", "row-4"]);
      expect(projection.materializedCount).toBe(5);
      const mixed = await list({ archived: "all", offset: 1, limit: 3 });
      expect(mixed).toMatchObject({ count: 3, totalCount: 7, nextOffset: 4 });
      expect(mixed.sessions.map((row) => row.sessionId)).toEqual(["row-5", "row-4", "row-3"]);
      expect(projection.materializedCount).toBe(5);
      const searched = await list({
        archived: true,
        search: "anthropic",
        hasBoard: false,
        limit: 1,
      });
      expect(searched).toMatchObject({ count: 1, totalCount: 4, nextOffset: 1 });
      expect(searched.sessions[0]?.sessionId).toBe("row-6");
      expect(projection.materializedCount).toBe(5);
      const tail = await list({ archived: true, offset: 2, limit: 2 });
      expect(tail).toMatchObject({ count: 2, totalCount: 4, nextOffset: null });
      expect(tail.sessions.map((row) => row.sessionId)).toEqual(["row-2", "row-0"]);
      expect(projection.materializedCount).toBe(7);
    } finally {
      projection.dispose();
      release();
    }
  });
});

it("describes and resolves a cold archived key through the registered handlers", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    setRuntimeConfigSnapshot(cfg);
    const key = "agent:main:archived-exact";
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key },
      { sessionId: "archived-exact", updatedAt: 1, archivedAt: 1, label: "Archived exact" },
    );
    const release = retainSessionListForegroundWork();
    const context = requestContext(cfg);
    await initializeSessionReadContext(context);
    const projection = getSessionRowProjection(context)!;
    try {
      expect(projection.materializedCount).toBe(0);
      const respond = vi.fn();
      await sessionByKeyReadHandlers["sessions.describe"]!({
        req: { type: "req", id: "archive-describe", method: "sessions.describe" },
        params: { key },
        context,
        client: null,
        isWebchatConnect: () => false,
        respond,
      });
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          session: expect.objectContaining({ key, sessionId: "archived-exact", archivedAt: 1 }),
        }),
      );
      sessionChanges.emit({ all: true, scope: "catalog" });
      await projection.ensureMaterialized();
      respond.mockClear();
      await sessionReadHandlers["sessions.resolve"]!({
        req: { type: "req", id: "archive-resolve", method: "sessions.resolve" },
        params: { key },
        context,
        client: null,
        isWebchatConnect: () => false,
        respond,
      });
      expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ key }), undefined);
      expect(projection.materializedCount).toBe(2);
    } finally {
      projection.dispose();
      release();
    }
  });
});

it("keeps archived visibility and membership current without warming hidden rows", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "main", default: true }] },
      gateway: {
        roles: {
          default: "reader",
          definitions: {
            reader: { agents: "*", scopes: ["operator.read"], sessions: { others: "view" } },
          },
        },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    const viewer = ensureProfileForEmail("archive-viewer@example.test").id;
    const owner = ensureProfileForEmail("archive-owner@example.test").id;
    for (const [name, visibility] of [
      ["hidden", "draft"],
      ["visible", "read-only"],
    ] as const) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: `agent:main:${name}` },
        {
          sessionId: name,
          updatedAt: 1,
          archivedAt: 1,
          visibility,
          createdActor: { type: "human", source: "profile", id: owner },
        },
      );
    }
    const target = { agentId: "main", sessionKey: "agent:main:visible" };
    addSessionMember(target, { identityId: viewer, addedBy: owner });
    const release = retainSessionListForegroundWork();
    const context = requestContext(cfg);
    const client = identifiedClient(viewer);
    await initializeSessionReadContext(context);
    const projection = getSessionRowProjection(context)!;
    try {
      const first = await listSessions({ context, client, request: { archived: true } });
      expect(first).toMatchObject({
        totalCount: 1,
        sessions: [{ key: target.sessionKey, sharingRole: "member" }],
      });
      expect(projection.materializedCount).toBe(1);
      removeSessionMember(target, viewer);
      const second = await listSessions({ context, client, request: { archived: true } });
      expect(second).toMatchObject({
        totalCount: 1,
        sessions: [{ key: target.sessionKey, sharingRole: "viewer" }],
      });
      expect(
        projection.capture({ agentId: "main", key: "agent:main:hidden" })?.materialized,
      ).toBeUndefined();
    } finally {
      projection.dispose();
      release();
    }
  });
});

it("hides cold archived cross-agent swarm children from a global parent", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
    async () => {
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
        gateway: {
          roles: {
            default: "reader",
            definitions: {
              reader: { agents: "*", scopes: ["operator.read"], sessions: { others: "view" } },
            },
          },
        },
      };
      setRuntimeConfigSnapshot(cfg);
      const viewer = ensureProfileForEmail("swarm-viewer@example.test").id;
      const owner = ensureProfileForEmail("swarm-owner@example.test").id;
      const child = "agent:work:subagent:archived-hidden";
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: "global" },
        {
          sessionId: "global-parent",
          updatedAt: 1,
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: viewer },
        },
      );
      replaceSessionEntrySync(
        { agentId: "work", sessionKey: child },
        {
          sessionId: "archived-hidden",
          updatedAt: 1,
          archivedAt: 1,
          visibility: "draft",
          parentSessionKey: "global",
          spawnedBy: "global",
          createdActor: { type: "human", source: "profile", id: owner },
        },
      );
      const run: SubagentRunRecord = {
        runId: "archived-swarm",
        childSessionKey: child,
        requesterSessionKey: "global",
        requesterAgentId: "main",
        requesterDisplayKey: "global",
        swarmRequesterSessionKey: "global",
        collect: true,
        groupId: "archived-group",
        task: "Synthetic task",
        cleanup: "keep",
        createdAt: 1,
        execution: { status: "running", startedAt: 1 },
        completion: { required: false },
        delivery: { status: "not_required" },
      };
      subagentRuns.set(run.runId, run);
      const release = retainSessionListForegroundWork();
      const context = requestContext(cfg);
      await initializeSessionReadContext(context);
      const projection = getSessionRowProjection(context)!;
      try {
        expect(
          projection.snapshot({ agentId: "main", key: "global" }).row?.swarm?.groups[0]?.children,
        ).toEqual([{ sessionKey: child, status: "running" }]);
        const result = await listSessions({
          context,
          client: identifiedClient(viewer),
          request: { agentId: "main", includeGlobal: true },
        });
        expect(result.sessions[0]?.swarm?.groups).toMatchObject([
          { groupId: "archived-group", children: [] },
        ]);
        expect(projection.capture({ agentId: "work", key: child })?.materialized).toBeUndefined();
      } finally {
        projection.dispose();
        release();
        subagentRuns.clear();
      }
    },
  );
});
