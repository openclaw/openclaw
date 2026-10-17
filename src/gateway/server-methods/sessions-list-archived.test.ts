import { afterEach, expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.native.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { retainSessionListForegroundWork } from "../session-projection-work.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import {
  identifiedClient,
  initializeSessionReadContext,
  listSessions,
  requestContext,
  sessionReadHandlers,
} from "./sessions-read-cache.test-support.js";

afterEach(() => vi.restoreAllMocks());

function seed(name: string, patch: Partial<SessionEntry> = {}, agentId = "main") {
  const scope = { agentId, sessionKey: name === "global" ? name : `agent:${agentId}:${name}` };
  replaceSessionEntrySync(scope, { sessionId: name, updatedAt: 1, ...patch });
}

function archiveConfig(
  agents: OpenClawConfig["agents"] = { entries: { main: {} } },
  gateway?: OpenClawConfig["gateway"],
) {
  const cfg = { agents, ...(gateway ? { gateway } : {}) };
  setRuntimeConfigSnapshot(cfg);
  return cfg;
}

async function archiveProjection(cfg: OpenClawConfig, viewer = "archive-viewer") {
  const release = retainSessionListForegroundWork();
  const context = requestContext(cfg);
  await initializeSessionReadContext(context);
  const projection = getSessionRowProjection(context)!;
  return {
    context,
    projection,
    get list() {
      const client = identifiedClient(viewer);
      return (request: Parameters<typeof listSessions>[0]["request"]) =>
        listSessions({ context, client, request });
    },
    [Symbol.dispose]() {
      projection.dispose();
      release();
    },
  };
}

const readerRoles: NonNullable<OpenClawConfig["gateway"]>["roles"] = {
  default: "reader",
  definitions: {
    reader: { agents: "*", scopes: ["operator.read"], sessions: { others: "view" } },
  },
};

it("pages and searches archived sessions without materializing excluded candidates", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = archiveConfig({
      defaults: { model: { primary: "anthropic/claude-sonnet-4-5" } },
      entries: { main: {} },
    });
    for (let index = 0; index < 7; index++) {
      seed(`row-${index}`, { updatedAt: index + 1, ...(index % 2 === 0 ? { archivedAt: 1 } : {}) });
    }
    using fixture = await archiveProjection(cfg);
    const { list, projection } = fixture;
    await projection.ensureMaterialized();
    expect(projection.materializedCount).toBe(3);
    for (const [request, count, totalCount, nextOffset, ids, materializedCount] of [
      [{ archived: true, limit: 2 }, 2, 4, 2, ["row-6", "row-4"], 5],
      [{ archived: "all", offset: 1, limit: 3 }, 3, 7, 4, ["row-5", "row-4", "row-3"], 5],
      [{ archived: true, search: "anthropic", hasBoard: false, limit: 1 }, 1, 4, 1, ["row-6"], 5],
      [{ archived: true, offset: 2, limit: 2 }, 2, 4, null, ["row-2", "row-0"], 7],
    ] as const) {
      expect(await list(request)).toMatchObject({
        count,
        totalCount,
        nextOffset,
        sessions: ids.map((sessionId) => ({ sessionId })),
      });
      expect(projection.materializedCount).toBe(materializedCount);
    }
  }));

it("resolves a cold archived key through the registered handler", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = archiveConfig();
    const key = "agent:main:archived-exact";
    seed("archived-exact", { archivedAt: 1, label: "Archived exact" });
    using fixture = await archiveProjection(cfg);
    const { context, projection } = fixture;
    expect(projection.materializedCount).toBe(0);
    const respond = vi.fn();
    await sessionReadHandlers["sessions.resolve"]!({
      req: { type: "req", id: "archive-resolve", method: "sessions.resolve" },
      params: { key },
      context,
      client: null,
      isWebchatConnect: () => false,
      respond,
    });
    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ key }), undefined);
    expect(projection.materializedCount).toBe(1);
  }));

it("keeps archived visibility and membership current without warming hidden rows", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = archiveConfig(undefined, { roles: readerRoles });
    const viewer = ensureProfileForEmail("archive-viewer@example.test").id;
    const owner = ensureProfileForEmail("archive-owner@example.test").id;
    for (const [name, visibility] of [
      ["hidden", "draft"],
      ["visible", "read-only"],
    ] as const) {
      seed(name, {
        archivedAt: 1,
        visibility,
        createdActor: { type: "human", source: "profile", id: owner },
      });
    }
    const target = { agentId: "main", sessionKey: "agent:main:visible" };
    addSessionMember(target, { identityId: viewer, addedBy: owner });
    using fixture = await archiveProjection(cfg, viewer);
    const { list, projection } = fixture;
    const expectRole = async (sharingRole: "member" | "viewer") => {
      expect(await list({ archived: true })).toMatchObject({
        totalCount: 1,
        sessions: [{ key: target.sessionKey, sharingRole }],
      });
    };
    await expectRole("member");
    expect(projection.materializedCount).toBe(1);
    removeSessionMember(target, viewer);
    await expectRole("viewer");
    expect(
      projection.capture({ agentId: "main", key: "agent:main:hidden" })?.materialized,
    ).toBeUndefined();
  }));

it("hides cold archived cross-agent swarm children from a global parent", () =>
  withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
    async () => {
      const cfg = archiveConfig(
        {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "main" } },
          entries: { main: {}, work: {} },
        },
        { roles: readerRoles },
      );
      const viewer = ensureProfileForEmail("swarm-viewer@example.test").id;
      const owner = ensureProfileForEmail("swarm-owner@example.test").id;
      const child = "agent:work:subagent:archived-hidden";
      seed("global", {
        sessionId: "global-parent",
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: viewer },
      });
      seed(
        "subagent:archived-hidden",
        {
          sessionId: "archived-hidden",
          archivedAt: 1,
          visibility: "draft",
          parentSessionKey: "global",
          spawnedBy: "global",
          createdActor: { type: "human", source: "profile", id: owner },
        },
        "work",
      );
      const run = createSubagentRunRecord({
        runId: "archived-swarm",
        childSessionKey: child,
        requesterSessionKey: "global",
        requesterAgentId: "main",
        requesterDisplayKey: "global",
        swarmRequesterSessionKey: "global",
        collect: true,
        groupId: "archived-group",
        createdAt: 1,
        execution: { status: "running", startedAt: 1 },
        delivery: { status: "not_required" },
      });
      subagentRuns.set(run.runId, run);
      try {
        using fixture = await archiveProjection(cfg, viewer);
        const { list, projection } = fixture;
        expect(
          projection.snapshot({ agentId: "main", key: "global" }).row?.swarm?.groups[0]?.children,
        ).toEqual([{ sessionKey: child, status: "running" }]);
        const result = await list({ agentId: "main", includeGlobal: true });
        expect(result.sessions[0]?.swarm?.groups).toMatchObject([
          { groupId: "archived-group", children: [] },
        ]);
        expect(projection.capture({ agentId: "work", key: child })?.materialized).toBeUndefined();
      } finally {
        subagentRuns.clear();
      }
    },
  ));
