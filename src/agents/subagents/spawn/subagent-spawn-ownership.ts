import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../../tools/sessions-helpers.js";

export function resolveSubagentSpawnOwnership(params: {
  cfg: OpenClawConfig;
  agentSessionKey?: string;
  completionOwnerKey?: string;
}) {
  const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
  const controllerSessionKey = params.agentSessionKey
    ? resolveInternalSessionKey({ key: params.agentSessionKey, alias })
    : alias;
  const completionOwnerKey = params.completionOwnerKey?.trim();
  const completionRequesterSessionKey = completionOwnerKey
    ? resolveInternalSessionKey({ key: completionOwnerKey, alias })
    : controllerSessionKey;
  // Completion ownership can differ from control ownership when a parent proxies the spawn.
  const completionRequesterDisplayKey = resolveDisplaySessionKey({
    key: completionRequesterSessionKey,
    alias,
    mainKey,
  });

  return {
    controllerSessionKey,
    completionRequesterSessionKey,
    completionRequesterDisplayKey,
  };
}
