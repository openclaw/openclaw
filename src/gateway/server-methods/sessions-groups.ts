// Session group catalog mutations.
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  missingScopeErrorShape,
  validateSessionsGroupsDefaultsParams,
  validateSessionsGroupsDeleteParams,
  validateSessionsGroupsListParams,
  validateSessionsGroupsPutParams,
  validateSessionsGroupsRenameParams,
  validateSessionsGroupsUpdateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { ADMIN_SCOPE } from "../method-scopes.js";
import { ensureSessionGroupCatalog } from "../session-group-catalog.js";
import { filterMutableSessionGroupRecords } from "../session-group-defaults-access.js";
import {
  deleteSessionGroup,
  listSessionGroupDefaults,
  listSidebarSectionOrder,
  listSessionGroups,
  putSessionGroups,
  renameSessionGroup,
  SessionGroupNotEmptyError,
  SessionGroupNotFoundError,
  updateSessionGroupDefaults,
} from "../session-groups.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams, defineValidatedGatewayHandler } from "./validation.js";
import {
  isWorkspacePathContainmentCurrent,
  resolveWorkspacePathContainment,
} from "./workspace-path-containment.js";

export const sessionGroupHandlers: GatewayRequestHandlers = {
  "sessions.groups.list": defineValidatedGatewayHandler(
    "sessions.groups.list",
    validateSessionsGroupsListParams,
    async ({ respond }) => {
      await ensureSessionGroupCatalog();
      respond(
        true,
        { groups: listSessionGroups(), sectionOrder: listSidebarSectionOrder() },
        undefined,
      );
    },
  ),
  "sessions.groups.defaults": defineValidatedGatewayHandler(
    "sessions.groups.defaults",
    validateSessionsGroupsDefaultsParams,
    async ({ respond, client, context }) => {
      await ensureSessionGroupCatalog();
      const defaults = await filterMutableSessionGroupRecords({
        client,
        context,
        records: () => listSessionGroupDefaults(),
      });
      respond(true, { defaults }, undefined);
    },
  ),
  "sessions.groups.put": async ({ params, respond, context, sessionMutationAuthorization }) => {
    if (
      !assertValidParams(params, validateSessionsGroupsPutParams, "sessions.groups.put", respond)
    ) {
      return;
    }
    try {
      const groups = await putSessionGroups({
        cfg: context.getRuntimeConfig(),
        names: params.names,
        sectionOrder: params.sectionOrder,
        assertCurrent: sessionMutationAuthorization?.assertCurrent,
        assertTargetCurrent: sessionMutationAuthorization?.assertTargetCurrent,
      });
      respond(true, { ok: true, groups, sectionOrder: listSidebarSectionOrder() }, undefined);
      // Catalog-only changes still need to reach other open clients.
      emitSessionsChanged(context, { reason: "groups" });
    } catch (error) {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        throw error;
      }
      if (error instanceof SessionGroupNotEmptyError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
        return;
      }
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    }
  },
  "sessions.groups.rename": defineValidatedGatewayHandler(
    "sessions.groups.rename",
    validateSessionsGroupsRenameParams,
    async ({ params, respond, context, sessionMutationAuthorization }) => {
      try {
        const result = await renameSessionGroup({
          cfg: context.getRuntimeConfig(),
          name: params.name,
          to: params.to,
          assertCurrent: sessionMutationAuthorization?.assertCurrent,
          assertTargetCurrent: sessionMutationAuthorization?.assertTargetCurrent,
        });
        respond(true, { ok: true, ...result }, undefined);
      } catch (error) {
        if (error instanceof SessionMutationAuthorizationChangedError) {
          throw error;
        }
        if (error instanceof SessionGroupNotFoundError) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
          return;
        }
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
      } finally {
        // Interrupted sweeps can retain catalog entries and committed member moves.
        emitSessionsChanged(context, { reason: "groups" });
      }
    },
  ),
  "sessions.groups.update": defineValidatedGatewayHandler(
    "sessions.groups.update",
    validateSessionsGroupsUpdateParams,
    async ({ params, respond, context, client, sessionMutationAuthorization }) => {
      if (params.cwd && !path.isAbsolute(params.cwd)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "session group cwd must be absolute"),
        );
        return;
      }
      const name = normalizeOptionalString(params.name);
      if (!name) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "session group name must not be empty"),
        );
        return;
      }
      let cwd = params.cwd;
      const clientScopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
      if (cwd && !clientScopes.includes(ADMIN_SCOPE)) {
        const containment = await resolveWorkspacePathContainment(cwd, context.getRuntimeConfig());
        if (
          !containment ||
          !isWorkspacePathContainmentCurrent(containment, context.getRuntimeConfig())
        ) {
          respond(
            false,
            undefined,
            missingScopeErrorShape({ missingScope: ADMIN_SCOPE, requiredScopes: [ADMIN_SCOPE] }),
          );
          return;
        }
        cwd = containment.path;
      }
      const assertCurrent = (
        currentTargets?: readonly { sessionKey: string; agentId?: string }[],
      ) => {
        sessionMutationAuthorization?.assertCurrent();
        if (sessionMutationAuthorization) {
          for (const target of currentTargets ?? []) {
            sessionMutationAuthorization.assertTargetCurrent(target);
          }
        }
      };
      const defaults = await updateSessionGroupDefaults(
        name,
        {
          cwd,
          worktree: params.worktree,
        },
        process.env,
        assertCurrent,
        context.getRuntimeConfig(),
      );
      if (!defaults) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unknown session group: ${name}`),
        );
        return;
      }
      respond(
        true,
        {
          ok: true,
          defaults: await filterMutableSessionGroupRecords({
            client,
            context,
            records: () => listSessionGroupDefaults(),
          }),
        },
        undefined,
      );
      emitSessionsChanged(context, { reason: "groups" });
    },
  ),
  "sessions.groups.delete": defineValidatedGatewayHandler(
    "sessions.groups.delete",
    validateSessionsGroupsDeleteParams,
    async ({ params, respond, context, sessionMutationAuthorization }) => {
      try {
        const result = await deleteSessionGroup({
          cfg: context.getRuntimeConfig(),
          name: params.name,
          assertCurrent: sessionMutationAuthorization?.assertCurrent,
          assertTargetCurrent: sessionMutationAuthorization?.assertTargetCurrent,
        });
        respond(true, { ok: true, ...result }, undefined);
      } catch (error) {
        if (error instanceof SessionMutationAuthorizationChangedError) {
          throw error;
        }
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
      } finally {
        emitSessionsChanged(context, { reason: "groups" });
      }
    },
  ),
};
