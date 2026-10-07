import type { OperatorModelPolicySnapshot } from "../agents/operator-model-policy.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { GatewayAccessGrantRef } from "../plugins/gateway-access-policy.types.js";
import type { GatewayAuthPolicy } from "./auth-policy.types.js";

/** Original authenticated basis, not an executable grant or a transport credential. */
export type OperatorRunRecoverySnapshot = {
  profileId: string;
  scopes: string[];
  assignedRole: string | null;
  githubLogin: string | null;
  rolePolicy?: Omit<GatewayOperatorRoleDefinition, "modelPolicy">;
  modelPolicy?: OperatorModelPolicySnapshot;
  grant: GatewayAccessGrantRef | null;
  aliasBindingIds: string[];
  authPolicy: GatewayAuthPolicy;
  sharedGeneration?: string;
  device?: { deviceId: string; key: string };
  controlUiAdmin: boolean;
  localOperator: boolean;
  sourceIngress: "control-ui" | "internal";
};

/** Private input custody; copied attribution or another session cannot authorize recovery. */
export type RestartRecoveryOperatorSource = {
  version: 1;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision?: string;
  sourceRunId: string;
  snapshot: OperatorRunRecoverySnapshot;
};
