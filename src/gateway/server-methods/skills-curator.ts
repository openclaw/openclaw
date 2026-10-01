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
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

function retiredSkillCuratorAction(method: `skills.curator.${"pin" | "restore" | "unpin"}`) {
  return defineValidatedGatewayHandler(method, validateSkillsCuratorActionParams, ({ respond }) => {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        formatErrorMessage(SKILL_LIFECYCLE_CURATION_RETIRED_MESSAGE),
      ),
    );
  });
}

export const skillsCuratorHandlers: GatewayRequestHandlers = {
  "skills.curator.status": defineValidatedGatewayHandler(
    "skills.curator.status",
    validateSkillsCuratorStatusParams,
    async ({ respond, context, client }) => {
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
  ),
  "skills.curator.pin": retiredSkillCuratorAction("skills.curator.pin"),
  "skills.curator.unpin": retiredSkillCuratorAction("skills.curator.unpin"),
  "skills.curator.restore": retiredSkillCuratorAction("skills.curator.restore"),
};
