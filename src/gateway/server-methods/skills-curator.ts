import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  ErrorCodes,
  errorShape,
  validateSkillsCuratorActionParams,
  validateSkillsCuratorStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  getSkillCuratorStatus,
  SKILL_LIFECYCLE_CURATION_RETIRED_MESSAGE,
} from "../../skills/workshop/curator.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function respondRetiredSkillCuratorAction(
  { params, respond }: GatewayRequestHandlerOptions,
  method: `skills.curator.${"pin" | "restore" | "unpin"}`,
): void {
  if (!assertValidParams(params, validateSkillsCuratorActionParams, method, respond)) {
    return;
  }
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      formatErrorMessage(SKILL_LIFECYCLE_CURATION_RETIRED_MESSAGE),
    ),
  );
}

export const skillsCuratorHandlers: GatewayRequestHandlers = {
  "skills.curator.status": async ({ params, respond, context, client }) => {
    if (
      !assertValidParams(
        params,
        validateSkillsCuratorStatusParams,
        "skills.curator.status",
        respond,
      )
    ) {
      return;
    }
    const status = await getSkillCuratorStatus({ config: context.getRuntimeConfig() });
    if (
      hasGatewayClientCap(client?.connect.caps, GATEWAY_CLIENT_CAPS.SKILL_CURATOR_LIVE_INVENTORY)
    ) {
      respond(true, status, undefined);
      return;
    }
    const { inventory: _inventory, ...legacyStatus } = status;
    const skills = status.skills.filter(
      (skill) => skill.createdAtMs !== null && skill.stateChangedAtMs !== null,
    );
    respond(
      true,
      { ...legacyStatus, skills, counts: { active: skills.length, stale: 0, archived: 0 } },
      undefined,
    );
  },
  "skills.curator.pin": (options) =>
    respondRetiredSkillCuratorAction(options, "skills.curator.pin"),
  "skills.curator.unpin": (options) =>
    respondRetiredSkillCuratorAction(options, "skills.curator.unpin"),
  "skills.curator.restore": (options) =>
    respondRetiredSkillCuratorAction(options, "skills.curator.restore"),
};
