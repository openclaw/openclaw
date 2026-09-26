import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { ToolAuthorizationError } from "../agents/tool-input-error.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  authorizeGatewaySessionCreation,
  resolveSandboxedSessionCreation,
} from "./operator-role-policy.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { authorizeSessionAgentRun } from "./session-sharing-policy.js";

/** Binds create-on-run provenance and row admission to the original operator. */
export function prepareGatewayOperatorSessionRun(params: {
  authority: AdmittedRunOperatorAuthority;
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  assertSourceCurrent: () => void;
}) {
  assertAdmittedRunOperatorAuthority(params.authority);
  const assertCurrent = () => {
    params.assertSourceCurrent();
    params.authority.assertCurrent();
  };
  assertCurrent();
  const client = createSyntheticPluginRuntimeClient({
    operatorRoleActor: { kind: "operator", profileId: params.authority.profileId },
    scopes: [...params.authority.scopes],
  });
  const creation = resolveSandboxedSessionCreation(
    { authenticatedUserProfile: { profileId: params.authority.profileId } },
    params.cfg,
  );
  return {
    creation: creation ? { ...creation, via: "run" as const } : undefined,
    assertCurrent,
    assertAuthorized: (entry: SessionEntry | undefined) => {
      assertCurrent();
      const error = entry
        ? authorizeSessionAgentRun({
            cfg: params.cfg,
            client,
            target: { agentId: params.agentId, canonicalKey: params.sessionKey, entry },
          })
        : authorizeGatewaySessionCreation({ cfg: params.cfg, client, agentId: params.agentId });
      if (error) {
        throw new ToolAuthorizationError(error.message);
      }
    },
  };
}
