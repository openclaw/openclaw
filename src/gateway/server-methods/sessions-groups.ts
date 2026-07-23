// Session group catalog mutations.
import {
  ErrorCodes,
  errorShape,
  validateSessionsGroupsAddParams,
  validateSessionsGroupsDeleteParams,
  validateSessionsGroupsListParams,
  validateSessionsGroupsPutParams,
  validateSessionsGroupsRenameParams,
  validateSessionsGroupsReorderParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  addSessionGroup,
  deleteSessionGroup,
  listSessionGroups,
  putSessionGroups,
  renameSessionGroup,
  reorderSessionGroups,
} from "../session-groups.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const sessionGroupHandlers: GatewayRequestHandlers = {
  "sessions.groups.list": async ({ params, respond }) => {
    if (
      !assertValidParams(params, validateSessionsGroupsListParams, "sessions.groups.list", respond)
    ) {
      return;
    }
    respond(true, { groups: listSessionGroups() }, undefined);
  },
  "sessions.groups.put": async ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validateSessionsGroupsPutParams, "sessions.groups.put", respond)
    ) {
      return;
    }
    putSessionGroups(params.names);
    respond(true, { ok: true, groups: listSessionGroups() }, undefined);
    // Catalog-only changes still need to reach other open clients.
    emitSessionsChanged(context, { reason: "groups" });
  },
  "sessions.groups.add": async ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validateSessionsGroupsAddParams, "sessions.groups.add", respond)
    ) {
      return;
    }
    try {
      addSessionGroup(params.name);
      respond(true, { ok: true, groups: listSessionGroups() }, undefined);
      emitSessionsChanged(context, { reason: "groups" });
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    }
  },
  "sessions.groups.reorder": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsGroupsReorderParams,
        "sessions.groups.reorder",
        respond,
      )
    ) {
      return;
    }
    respond(true, { ok: true, groups: reorderSessionGroups(params.names) }, undefined);
    emitSessionsChanged(context, { reason: "groups" });
  },
  "sessions.groups.rename": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsGroupsRenameParams,
        "sessions.groups.rename",
        respond,
      )
    ) {
      return;
    }
    try {
      const result = await renameSessionGroup({
        cfg: context.getRuntimeConfig(),
        name: params.name,
        to: params.to,
      });
      respond(true, { ok: true, ...result }, undefined);
      emitSessionsChanged(context, { reason: "groups" });
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    }
  },
  "sessions.groups.delete": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsGroupsDeleteParams,
        "sessions.groups.delete",
        respond,
      )
    ) {
      return;
    }
    try {
      const result = await deleteSessionGroup({
        cfg: context.getRuntimeConfig(),
        name: params.name,
      });
      respond(true, { ok: true, ...result }, undefined);
      emitSessionsChanged(context, { reason: "groups" });
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    }
  },
};
