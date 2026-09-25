import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  observeHostDataSql,
  trackSqliteStatementExecutions,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { AgentSelectionRequiredError } from "../agents/agent-scope.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../config/sessions/session-sharing-store.native.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import {
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { flushPendingSessionsChangedEvents } from "./server-methods/session-change-event.js";
import { sessionGroupHandlers } from "./server-methods/sessions-groups.js";
import { initializeSessionReadContext } from "./server-methods/sessions-read-cache.test-support.js";
import type { GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import { readSessionGroupMembership } from "./session-group-membership.read.js";
import {
  listSessionGroupDefaults,
  listSessionGroups,
  putSessionGroups,
  updateSessionGroupDefaults,
} from "./session-groups.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import {
  authorizeSessionSharingTarget,
  resolveSessionMutationAuthorization,
  resolveSessionSharingTarget,
} from "./session-sharing.js";
import {
  sharingPolicyClient as client,
  roleClient,
  rolePolicyConfig,
} from "./session-sharing.test-utils.js";

afterEach(async () => {
  await flushPendingSessionsChangedEvents();
  closeOpenClawAgentDatabasesForTest();
});

describe("session sharing group mutations", () => {
  it.each([
    { retiredOwner: false, logicalAgent: "research", discoveryAgent: "main", archived: false },
    { retiredOwner: false, logicalAgent: "research", discoveryAgent: "main", archived: true },
    { retiredOwner: true, logicalAgent: "ops", discoveryAgent: "ops", archived: false },
    { retiredOwner: true, logicalAgent: "ops", discoveryAgent: "ops", archived: true },
  ])(
    "preserves shared-store group selection and defaults access (retired physical owner=$retiredOwner, archived=$archived)",
    async ({ retiredOwner, logicalAgent, discoveryAgent, archived }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const storePath = state.statePath("shared.sqlite");
        const cfg = {
          session: { store: storePath },
          agents: {
            list: retiredOwner
              ? [{ id: "ops", default: true }, { id: "other" }]
              : [{ id: "main", default: true }, { id: "research" }],
          },
        };
        openOpenClawAgentDatabase({ agentId: "main", path: storePath });
        const sessionKey = `agent:${logicalAgent}:group-member`;
        const scope = { agentId: logicalAgent, storePath, sessionKey };
        await upsertSessionEntryCore(scope, {
          sessionId: "research-group-member",
          updatedAt: 1,
          category: "Research",
          ...(archived ? { archivedAt: 1 } : {}),
        });
        await putSessionGroups({ cfg, names: ["Research"] });
        const viewer = client({ user: "viewer" });
        const refs = new Map(readSessionGroupMembership(cfg, process.env).groups).get("Research");
        expect(refs).toEqual([{ sessionKey, agentId: discoveryAgent }]);
        const ref = expectDefined(refs?.[0], "shared-store group member");
        const resolveTarget = () => resolveSessionSharingTarget({ cfg, ...ref });
        if (retiredOwner) {
          const target = expectDefined(resolveTarget(), "shared-store sharing target");
          expect(authorizeSessionSharingTarget({ cfg, client: viewer, target })).toBeNull();
        } else {
          expect(resolveTarget).toThrow(AgentSelectionRequiredError);
        }
        const context = { getRuntimeConfig: () => cfg } as GatewayRequestContext;
        await initializeSessionReadContext(context);
        const projection = expectDefined(
          getSessionRowProjection(context),
          "prepared group projection",
        );
        await projection.prepareMembership();
        expect(projection.sessionGroupTargets().get("Research")).toEqual(refs);
        const query = { agentId: logicalAgent, key: sessionKey };
        const row = expectDefined(projection.capture(query), "shared-store projected row");
        expect(row.storeTarget).toMatchObject({ agentId: "main", storePath });
        expect(row.entry?.archivedAt).toBe(archived ? 1 : undefined);
        expect(Boolean(row.materialized)).toBe(!archived);
        const readDefaults = async (visible = true) => {
          const respond = vi.fn();
          const defaults = sessionGroupHandlers["sessions.groups.defaults"]!({
            params: {},
            client: viewer,
            context,
            respond,
          } as never);
          if (retiredOwner) {
            await defaults;
            expect(respond).toHaveBeenCalledExactlyOnceWith(
              true,
              { defaults: visible ? [{ name: "Research" }] : [] },
              undefined,
            );
          } else {
            await expect(defaults).rejects.toThrow(AgentSelectionRequiredError);
            expect(respond).not.toHaveBeenCalled();
          }
          if (archived) {
            expect(projection.capture(query)?.materialized).toBeUndefined();
            expect(projection.materializedCount).toBe(0);
          }
        };
        await readDefaults();
        const sql = observeHostDataSql();
        try {
          await readDefaults();
          expect(sql.queries).toEqual([]);
        } finally {
          sql.restore();
        }
        if (retiredOwner) {
          await upsertSessionEntryCore(scope, { visibility: "read-only" });
          await readDefaults(false);
          addSessionMember(scope, { identityId: "viewer", addedBy: "owner", addedAt: 1 });
          await readDefaults();
          removeSessionMember(scope, "viewer");
          await readDefaults(false);
        }
      });
    },
  );

  it("reuses group membership metadata and immediately observes changed member permissions", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = {};
      await putSessionGroups({ cfg, names: ["Projects", "Personal"] });
      const scope = { agentId: "main", sessionKey: "agent:main:restricted-group-member" };
      await upsertSessionEntryCore(scope, {
        sessionId: "restricted-group-member",
        updatedAt: Date.now(),
        category: "Projects",
        visibility: "read-only",
        createdActor: { type: "human", source: "profile", id: "owner@example.com" },
      });
      const viewer = client({ user: "viewer@example.com" });
      const context = {
        getRuntimeConfig: () => cfg,
        getSessionEventSubscriberConnIds: () => new Set<string>(),
      } as unknown as GatewayRequestContext;
      const readDefaults = async () => {
        await initializeSessionReadContext(context);
        await getSessionRowProjection(context)!.prepareMembership();
        const responses: Parameters<RespondFn>[] = [];
        await sessionGroupHandlers["sessions.groups.defaults"]!({
          req: { type: "req", id: "group-defaults-test", method: "sessions.groups.defaults" },
          params: {},
          client: viewer,
          context,
          isWebchatConnect: () => true,
          respond: (...response) => responses.push(response),
        });
        expect(responses).toHaveLength(1);
        expect(responses[0]?.[0]).toBe(true);
        return responses[0]?.[1];
      };
      const database = expectDefined(
        getOpenClawAgentDatabaseIfOpen(scope),
        "seeded agent database",
      );
      const queries = trackSqliteStatementExecutions(database.db, ["entries"], (sql) =>
        /\bselect\b/i.test(sql) && /\bsession_nodes\b/.test(sql) && /\bentry_json\b/.test(sql)
          ? "entries"
          : null,
      );
      try {
        expect(await readDefaults()).toEqual({ defaults: [{ name: "Personal" }] });
        queries.counts.entries = 0;
        queries.rowCounts.entries = 0;
        for (let index = 0; index < 3; index++) {
          expect(await readDefaults()).toEqual({ defaults: [{ name: "Personal" }] });
        }
        expect(queries.counts.entries).toBe(0);
        expect(queries.rowCounts.entries).toBe(0);

        await upsertSessionEntryCore(scope, { category: "Personal" });
        expect(await readDefaults()).toEqual({ defaults: [{ name: "Projects" }] });
        await upsertSessionEntryCore(scope, { visibility: "shared" });
        expect(await readDefaults()).toEqual({
          defaults: [{ name: "Projects" }, { name: "Personal" }],
        });
      } finally {
        queries.restore();
      }
    });
  });

  it.each(["rename", "delete"])(
    "refreshes groups after %s rejects changed member authority",
    async (action) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        await putSessionGroups({ cfg: {}, names: ["Old"] });
        const sessionKey = "agent:main:changed-group-authority";
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: "changed-group-authority",
            updatedAt: 1,
            category: "Old",
          },
        );
        const error = new SessionMutationAuthorizationChangedError({
          code: "INVALID_REQUEST",
          message: "member authority changed",
          details: { reason: "changed" },
        });
        const broadcastToConnIds = vi.fn();
        const respond = vi.fn();
        const context = {
          getRuntimeConfig: () => ({}),
          getSessionEventSubscriberConnIds: () => new Set(["group-observer"]),
          broadcastToConnIds,
        } as unknown as GatewayRequestContext;
        await expect(
          sessionGroupHandlers[`sessions.groups.${action}`]?.({
            params: { name: "Old", ...(action === "rename" ? { to: "New" } : {}) },
            context,
            respond,
            sessionMutationAuthorization: {
              assertCurrent: () => {},
              assertTargetCurrent: () => {
                throw error;
              },
            },
          } as never),
        ).rejects.toMatchObject({
          name: "SessionMutationAuthorizationChangedError",
          error: {
            code: "INVALID_REQUEST",
            details: { reason: "changed" },
            message: expect.stringContaining("retry"),
          },
        });
        expect(respond).not.toHaveBeenCalled();
        expect(loadSessionEntry({ agentId: "main", sessionKey })?.category).toBe("Old");
        expect(listSessionGroups()).toContainEqual({ name: "Old", position: 0 });
        expect(broadcastToConnIds).toHaveBeenCalledWith(
          "sessions.changed",
          expect.objectContaining({ reason: "groups" }),
          new Set(["group-observer"]),
          expect.any(Object),
        );
      });
    },
  );
  it("refuses restricted group drops at put admission while allowing retained groups", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await putSessionGroups({ cfg: {}, names: ["Projects"] });
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:restricted-put-member" },
        {
          sessionId: "session-restricted-put-member",
          updatedAt: 1,
          visibility: "read-only",
          category: "Projects",
          createdActor: { type: "human", source: "profile", id: "owner@example.com" },
        },
      );
      const viewer = roleClient("none", "put-viewer");
      const context = { getRuntimeConfig: () => rolePolicyConfig() } as GatewayRequestContext;

      await initializeSessionReadContext(context);
      await getSessionRowProjection(context)!.prepareMembership();
      expect(
        resolveSessionMutationAuthorization({
          client: viewer,
          method: "sessions.groups.put",
          requestParams: { names: [] },
          context,
        }).error,
      ).not.toBeNull();
      expect(
        resolveSessionMutationAuthorization({
          client: viewer,
          method: "sessions.groups.put",
          requestParams: { names: [" Projects "] },
          context,
        }).error,
      ).toBeNull();
    });
  });

  it("rechecks late group members before committing a put drop", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const groups = await putSessionGroups({ cfg: {}, names: ["Race"] });
      const viewer = roleClient("none", "put-viewer");
      const context = {
        getRuntimeConfig: () => rolePolicyConfig(),
        getSessionEventSubscriberConnIds: () => new Set<string>(),
      } as unknown as GatewayRequestContext;
      await initializeSessionReadContext(context);
      await getSessionRowProjection(context)!.prepareMembership();
      const authorization = resolveSessionMutationAuthorization({
        client: viewer,
        method: "sessions.groups.put",
        requestParams: { names: [] },
        context,
      });
      expect(authorization).toMatchObject({ error: null, authorization: expect.any(Object) });

      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:late-put-member" },
        {
          sessionId: "session-late-put-member",
          updatedAt: 1,
          visibility: "read-only",
          category: "Race",
          createdActor: { type: "human", source: "profile", id: "owner@example.com" },
        },
      );

      await expect(
        sessionGroupHandlers["sessions.groups.put"]?.({
          params: { names: [] },
          client: viewer,
          context,
          sessionMutationAuthorization: authorization.authorization,
          respond: () => undefined,
        } as never),
      ).rejects.toBeInstanceOf(SessionMutationAuthorizationChangedError);
      expect(listSessionGroups()).toEqual(groups);
    });
  });

  it.each(["transaction", "commit"] as const)(
    "rechecks group members at %s admission for a defaults update",
    async (stage) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        await putSessionGroups({ cfg: {}, names: ["Race"] });
        await updateSessionGroupDefaults("Race", { cwd: "/repos/race", worktree: true });
        const cfg = rolePolicyConfig();
        const writeRole = expectDefined(cfg.gateway?.roles?.definitions.write, "write role");
        const viewer = roleClient("write", "defaults-viewer");
        const addMember = () =>
          upsertSessionEntryCore(
            { agentId: "main", sessionKey: "agent:main:late-restricted-member" },
            {
              sessionId: "session-late-restricted-member",
              updatedAt: 1,
              visibility: "read-only",
              category: "Race",
              createdActor: { type: "human", source: "profile", id: "owner@example.com" },
            },
          );
        if (stage === "commit") {
          await addMember();
        }
        const context = {
          getRuntimeConfig: () => cfg,
          getSessionEventSubscriberConnIds: () => new Set<string>(),
        } as unknown as GatewayRequestContext;
        await initializeSessionReadContext(context);
        await getSessionRowProjection(context)!.prepareMembership();
        const authorization = resolveSessionMutationAuthorization({
          client: viewer,
          method: "sessions.groups.update",
          requestParams: { name: " Race ", cwd: null, worktree: false },
          context,
        });
        expect(authorization.error).toBeNull();

        if (stage === "transaction") {
          await addMember();
        }

        let commitRequested = false;
        const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
        const admissionSpy = vi
          .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
          .mockImplementation((admit) =>
            createAdmission((request, grant) => {
              if (request.stage === "commit") {
                commitRequested = true;
                writeRole.sessions.others = "none";
              }
              admit(request, grant);
            }),
          );
        try {
          await expect(
            sessionGroupHandlers["sessions.groups.update"]?.({
              params: { name: " Race ", cwd: null, worktree: false },
              client: viewer,
              context,
              sessionMutationAuthorization: authorization.authorization,
              respond: () => undefined,
            } as never),
          ).rejects.toBeInstanceOf(SessionMutationAuthorizationChangedError);
          expect(commitRequested).toBe(stage === "commit");
        } finally {
          admissionSpy.mockRestore();
        }
        expect(listSessionGroupDefaults()).toEqual([
          { name: "Race", cwd: "/repos/race", worktree: true },
        ]);
      });
    },
  );

  it("filters group defaults and blocks updates for sessions the caller cannot mutate", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await putSessionGroups({ cfg: {}, names: ["Projects", "Personal"] });
      await updateSessionGroupDefaults("Projects", { cwd: "/repos/projects", worktree: true });
      await updateSessionGroupDefaults("Personal", { cwd: "/repos/personal", worktree: false });
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:restricted-project" },
        {
          sessionId: "session-restricted-project",
          updatedAt: 1,
          visibility: "read-only",
          category: "Projects",
          createdActor: { type: "human", source: "profile", id: "owner@example.com" },
        },
      );
      const viewer = client({ user: "viewer@example.com" });
      const context = {
        getRuntimeConfig: () => ({}),
        getSessionEventSubscriberConnIds: () => new Set<string>(),
      } as unknown as GatewayRequestContext;

      await initializeSessionReadContext(context);
      await getSessionRowProjection(context)!.prepareMembership();
      expect(
        resolveSessionMutationAuthorization({
          client: viewer,
          method: "sessions.groups.update",
          requestParams: { name: "Projects", cwd: null, worktree: false },
          context,
        }).error,
      ).toMatchObject({ details: { code: "SESSION_PARTICIPATION_REQUIRED" } });

      const responses: Parameters<RespondFn>[] = [];
      await initializeSessionReadContext(context);
      await getSessionRowProjection(context)!.prepareMembership();
      await sessionGroupHandlers["sessions.groups.defaults"]?.({
        params: {},
        client: viewer,
        context,
        respond: (...response: Parameters<RespondFn>) => responses.push(response),
      } as never);
      expect(responses).toEqual([
        [
          true,
          { defaults: [{ name: "Personal", cwd: "/repos/personal", worktree: false }] },
          undefined,
        ],
      ]);

      const personalAuthorization = resolveSessionMutationAuthorization({
        client: viewer,
        method: "sessions.groups.update",
        requestParams: { name: "Personal", cwd: null, worktree: false },
        context,
      });
      expect(personalAuthorization.error).toBeNull();
      const updateResponses: Parameters<RespondFn>[] = [];
      await sessionGroupHandlers["sessions.groups.update"]?.({
        params: { name: "Personal", cwd: null, worktree: false },
        client: viewer,
        context,
        sessionMutationAuthorization: personalAuthorization.authorization,
        respond: (...response: Parameters<RespondFn>) => updateResponses.push(response),
      } as never);
      expect(updateResponses).toEqual([
        [true, { ok: true, defaults: [{ name: "Personal", worktree: false }] }, undefined],
      ]);
    });
  });
});
