import { isDeepStrictEqual } from "node:util";
import { resolveSessionCreationVisibility } from "../../config/sessions/creation-visibility.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveCreatorSandbox } from "../operator-role-policy.js";
import { resolveOperatorSessionCreation } from "../session-creation-provenance.js";
import { isAttendedControlUiSessionCreator } from "./gateway-personal-caller.js";
import { sessionChangedError } from "./sessions-patch-errors.js";
import type { GatewayClient } from "./types.js";

export function resolvePatchOperatorCreation(cfg: OpenClawConfig, client: GatewayClient | null) {
  const creation = resolveOperatorSessionCreation(client);
  const sandbox = resolveCreatorSandbox(cfg, creation);
  return { ...creation, ...(sandbox ? { sandbox } : {}) };
}

export function createPatchCreationPolicy(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  getCurrentConfig: () => OpenClawConfig;
}) {
  const creation = resolvePatchOperatorCreation(params.cfg, params.client);
  const attended = () =>
    isAttendedControlUiSessionCreator(params.client) &&
    creation.via === "operator" &&
    creation.actor?.type === "human" &&
    creation.actor.source === "profile" &&
    creation.actor.id === params.client?.authenticatedUserProfile?.profileId;
  return {
    creation,
    attended,
    commitGuard: (sessionKey: string, targetKey: string) => {
      const resolveDefault = (cfg: OpenClawConfig) =>
        resolveSessionCreationVisibility(cfg, sessionKey, undefined, {
          attendedProfileOperator: attended(),
        }).access;
      const admittedDefault = resolveDefault(params.cfg);
      return () =>
        isDeepStrictEqual(admittedDefault, resolveDefault(params.getCurrentConfig()))
          ? undefined
          : sessionChangedError(targetKey);
    },
  };
}
