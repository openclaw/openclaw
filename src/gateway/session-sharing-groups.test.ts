import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { AgentSelectionRequiredError } from "../agents/agent-scope.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../config/sessions/session-sharing-store.native.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { flushPendingSessionsChangedEvents } from "./server-methods/session-change-event.js";
import { sessionGroupHandlers } from "./server-methods/sessions-groups.js";
import { initializeSessionReadContext } from "./server-methods/sessions-read-cache.test-support.js";
import type { GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import { readSessionGroupCatalog } from "./session-group-catalog.js";
import { readSessionGroupMembership } from "./session-group-membership.read.js";
import { putSessionGroups, updateSessionGroupDefaults } from "./session-groups.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import {
  authorizeResolvedSessionMutationAsync,
  resolveSessionMutationAuthorization,
  resolveSessionSharingTargetAsync,
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

const subscriberContext = (cfg: OpenClawConfig) =>
  ({
    getRuntimeConfig: () => cfg,
    getSessionEventSubscriberConnIds: () => new Set<string>(),
  }) as unknown as GatewayRequestContext;
async function prepareMembership(context: GatewayRequestContext) {
  await initializeSessionReadContext(context);
  const projection = expectDefined(getSessionRowProjection(context), "prepared group projection");
  await projection.prepareMembership();
  return projection;
}
const restrictedMember = (
  key: string,
  category: string,
  sessionId = `session-${key}`,
  updatedAt = 1,
) =>
  upsertSessionEntryCore(
    { agentId: "main", sessionKey: `agent:main:${key}` },
    {
      sessionId,
      updatedAt,
      visibility: "read-only",
      category,
      createdActor: { type: "human", source: "profile", id: "owner@example.com" },
    },
  );
function groupAuthorization(
  context: GatewayRequestContext,
  viewer: Parameters<typeof resolveSessionMutationAuthorization>[0]["client"],
  action: "put" | "update",
  requestParams: Record<string, unknown>,
) {
  return resolveSessionMutationAuthorization({
    client: viewer,
    context,
    method: `sessions.groups.${action}`,
    requestParams,
  });
}

describe("session sharing group mutations", () => {
  it.each([
    { retiredOwner: false, logicalAgent: "research", discoveryAgent: "main", archived: true },
    { retiredOwner: true, logicalAgent: "ops", discoveryAgent: "ops", archived: false },
    { retiredOwner: true, logicalAgent: "ops", discoveryAgent: "ops", archived: true },
  ])(
    "preserves shared-store group selection and defaults access (retired physical owner=$retiredOwner, archived=$archived)",
    async ({ retiredOwner, logicalAgent, discoveryAgent, archived }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const storePath = state.statePath("shared.sqlite");
        const cfg: OpenClawConfig = {
          session: { store: storePath },
          agents: {
            defaults: { sessionStore: { agentId: discoveryAgent } },
            entries: retiredOwner ? { ops: {}, other: {} } : { main: {}, research: {} },
          },
        };
        setRuntimeConfigSnapshot(cfg);
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
        const resolveTarget = () => resolveSessionSharingTargetAsync({ cfg, ...ref });
        if (retiredOwner) {
          expectDefined(await resolveTarget(), "shared-store sharing target");
          expect(
            await authorizeResolvedSessionMutationAsync({ cfg, client: viewer, ...ref }),
          ).toBeNull();
        } else {
          await expect(resolveTarget()).rejects.toThrow(AgentSelectionRequiredError);
        }
        const context = { getRuntimeConfig: () => cfg } as GatewayRequestContext;
        const projection = await prepareMembership(context);
        expect(projection.sessionGroupTargets().get("Research")).toEqual(refs);
        const query = { agentId: logicalAgent, key: sessionKey };
        const row = expectDefined(projection.capture(query), "shared-store projected row");
        expect(row.storeTarget).toMatchObject({ agentId: "main", storePath });
        expect(row.entry?.archivedAt).toBe(archived ? 1 : undefined);
        expect(row.materialized).toBeUndefined();
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
      setRuntimeConfigSnapshot(cfg);
      await putSessionGroups({ cfg, names: ["Projects", "Personal"] });
      const scope = { agentId: "main", sessionKey: "agent:main:restricted-group-member" };
      await restrictedMember(
        "restricted-group-member",
        "Projects",
        "restricted-group-member",
        Date.now(),
      );
      const viewer = client({ user: "viewer@example.com" });
      const context = subscriberContext(cfg);
      const readDefaults = async () => {
        await prepareMembership(context);
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
      expect(await readDefaults()).toEqual({ defaults: [{ name: "Personal" }] });
      const sql = observeHostDataSql();
      try {
        for (let index = 0; index < 3; index++) {
          expect(await readDefaults()).toEqual({ defaults: [{ name: "Personal" }] });
        }
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }

      await upsertSessionEntryCore(scope, { category: "Personal" });
      expect(await readDefaults()).toEqual({ defaults: [{ name: "Projects" }] });
      await upsertSessionEntryCore(scope, { visibility: "shared" });
      expect(await readDefaults()).toEqual({
        defaults: [{ name: "Projects" }, { name: "Personal" }],
      });
    });
  });

  it.each(["rename", "delete"])(
    "refreshes groups after %s rejects changed member authority",
    async (action) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        setRuntimeConfigSnapshot({});
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
        expect(readSessionGroupCatalog().groups).toContainEqual({ name: "Old", position: 0 });
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
      const cfg = rolePolicyConfig();
      setRuntimeConfigSnapshot(cfg);
      await putSessionGroups({ cfg: {}, names: ["Projects"] });
      await restrictedMember("restricted-put-member", "Projects");
      const viewer = roleClient("none", "put-viewer");
      const context = { getRuntimeConfig: () => cfg } as GatewayRequestContext;

      await prepareMembership(context);
      expect(groupAuthorization(context, viewer, "put", { names: [] }).error).not.toBeNull();
      expect(
        groupAuthorization(context, viewer, "put", { names: [" Projects "] }).error,
      ).toBeNull();
    });
  });

  it("rechecks late group members before committing a put drop", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = rolePolicyConfig();
      setRuntimeConfigSnapshot(cfg);
      const groups = await putSessionGroups({ cfg: {}, names: ["Race"] });
      const viewer = roleClient("none", "put-viewer");
      const context = subscriberContext(cfg);
      await prepareMembership(context);
      const authorization = groupAuthorization(context, viewer, "put", { names: [] });
      expect(authorization).toMatchObject({ error: null, authorization: expect.any(Object) });

      await restrictedMember("late-put-member", "Race");

      await expect(
        sessionGroupHandlers["sessions.groups.put"]?.({
          params: { names: [] },
          client: viewer,
          context,
          sessionMutationAuthorization: authorization.authorization,
          respond: () => undefined,
        } as never),
      ).rejects.toBeInstanceOf(SessionMutationAuthorizationChangedError);
      expect(readSessionGroupCatalog().groups).toEqual(groups);
    });
  });

  it.each(["transaction", "commit"] as const)(
    "rechecks group members at %s admission for a defaults update",
    async (stage) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const cfg = rolePolicyConfig();
        setRuntimeConfigSnapshot(cfg);
        await putSessionGroups({ cfg: {}, names: ["Race"] });
        await updateSessionGroupDefaults("Race", { cwd: "/repos/race", worktree: true });
        const writeRole = expectDefined(cfg.gateway?.roles?.definitions.write, "write role");
        const viewer = roleClient("write", "defaults-viewer");
        const addMember = () => restrictedMember("late-restricted-member", "Race");
        if (stage === "commit") {
          await addMember();
        }
        const context = subscriberContext(cfg);
        await prepareMembership(context);
        const authorization = groupAuthorization(context, viewer, "update", {
          name: " Race ",
          cwd: null,
          worktree: false,
        });
        expect(authorization.error).toBeNull();

        if (stage === "transaction") {
          await addMember();
        }

        let commitRequested = false;
        let targetTransactionObserved = false;
        const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
        const admissionSpy = vi
          .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
          .mockImplementation((admit, attachment) => {
            let isTargetCatalogAdmission = false;
            return createAdmission((request, grant) => {
              // Deferred session maintenance uses this factory too.
              if (
                request.stage === "transaction" &&
                isRecord(request.facts) &&
                Array.isArray(request.facts.groups) &&
                request.facts.groups.some((group) => Array.isArray(group) && group[0] === "Race")
              ) {
                isTargetCatalogAdmission = true;
                targetTransactionObserved = true;
              }
              if (isTargetCatalogAdmission && request.stage === "commit") {
                commitRequested = true;
                writeRole.sessions.others = "none";
              }
              admit(request, grant);
            }, attachment);
          });
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
          expect(targetTransactionObserved).toBe(true);
          expect(commitRequested).toBe(stage === "commit");
        } finally {
          admissionSpy.mockRestore();
        }
        expect(readSessionGroupCatalog().defaults).toEqual([
          { name: "Race", cwd: "/repos/race", worktree: true },
        ]);
      });
    },
  );

  it("filters group defaults and blocks updates for sessions the caller cannot mutate", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = {};
      setRuntimeConfigSnapshot(cfg);
      await putSessionGroups({ cfg: {}, names: ["Projects", "Personal"] });
      await updateSessionGroupDefaults("Projects", { cwd: "/repos/projects", worktree: true });
      await updateSessionGroupDefaults("Personal", { cwd: "/repos/personal", worktree: false });
      await restrictedMember("restricted-project", "Projects");
      const viewer = client({ user: "viewer@example.com" });
      const context = subscriberContext(cfg);

      await prepareMembership(context);
      expect(
        groupAuthorization(context, viewer, "update", {
          name: "Projects",
          cwd: null,
          worktree: false,
        }).error,
      ).toMatchObject({ details: { code: "SESSION_PARTICIPATION_REQUIRED" } });

      const responses: Parameters<RespondFn>[] = [];
      await prepareMembership(context);
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

      const personalAuthorization = groupAuthorization(context, viewer, "update", {
        name: "Personal",
        cwd: null,
        worktree: false,
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
