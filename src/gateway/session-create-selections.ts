import type { Result } from "@openclaw/normalization-core/result";
import type { ErrorShape } from "../../packages/gateway-protocol/src/index.js";
import { missingScopeErrorShape } from "../../packages/gateway-protocol/src/index.js";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { resolveAgentConfig } from "../agents/agent-scope.js";
import type { InternalSessionEntry } from "../config/sessions.js";
import { ADMIN_SCOPE } from "./operator-scopes.js";
import { prepareSessionCreateModelSelection } from "./session-create-model-selection.js";
import type { CreateGatewaySessionParams } from "./session-create-service.types.js";

export class SessionCreatePermissionDefaultChangedError extends Error {
  constructor() {
    super("New-session permission default changed; retry creation.");
  }
}

type PermissionDefault = {
  mode: NonNullable<InternalSessionEntry["permissionMode"]>;
  assertCurrent: () => void;
};

function prepareSessionCreatePermissionDefault(
  params: CreateGatewaySessionParams,
  agentId: string,
  existing: InternalSessionEntry | undefined,
  authority: AdmittedRunOperatorAuthority | undefined,
): Result<PermissionDefault | undefined, ErrorShape> {
  if (
    existing ||
    params.permissionMode !== undefined ||
    !params.applyAgentPermissionDefault ||
    params.creation?.via !== "operator" ||
    params.fork ||
    params.initialEntry ||
    params.catalogTarget ||
    params.authorizedPluginId ||
    params.authorizedAgentHarnessId ||
    !authority
  ) {
    return { ok: true, value: undefined };
  }
  const mode = resolveAgentConfig(params.cfg, agentId)?.newSessionPermissionMode;
  if (!mode) {
    return { ok: true, value: undefined };
  }
  authority.assertCurrent();
  if (mode === "full" && !authority.scopes.includes(ADMIN_SCOPE)) {
    return {
      ok: false,
      error: missingScopeErrorShape({ missingScope: ADMIN_SCOPE, requiredScopes: [ADMIN_SCOPE] }),
    };
  }
  const assertCurrent = () => {
    authority.assertCurrent();
    if (
      resolveAgentConfig(params.getCurrentConfig?.() ?? params.cfg, agentId)
        ?.newSessionPermissionMode !== mode
    ) {
      throw new SessionCreatePermissionDefaultChangedError();
    }
  };
  assertCurrent();
  return { ok: true, value: { mode, assertCurrent } };
}

/** Creation prepares one model/permission snapshot before resources and keeps both fences through commit. */
export function prepareSessionCreateSelections(
  params: CreateGatewaySessionParams,
  agentId: string,
  existing: InternalSessionEntry | undefined,
  parent: InternalSessionEntry | undefined,
  authority: AdmittedRunOperatorAuthority | undefined,
) {
  const permission = prepareSessionCreatePermissionDefault(params, agentId, existing, authority);
  if (!permission.ok) {
    return permission;
  }
  const model = prepareSessionCreateModelSelection({
    cfg: params.cfg,
    agentId,
    input:
      params.catalogTarget ??
      (params.model ? { model: params.model, agentRuntime: params.agentRuntime } : undefined),
    parentEntry: parent,
    preparedModelSelection: params.preparedModelSelection?.ref,
    operatorAuthority: authority,
  });
  if (!model.ok) {
    return model;
  }
  return {
    ...model,
    permissionMode: permission.value?.mode,
    validate: () => {
      permission.value?.assertCurrent();
      return model.validate?.();
    },
  };
}
