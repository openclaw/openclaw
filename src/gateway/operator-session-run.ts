import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { ToolAuthorizationError } from "../agents/tool-input-error.js";
import { createSessionWorkStartChangedError } from "../config/sessions/lifecycle.js";
import {
  composeSessionSourceAssertion,
  createDynamicSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { authorizeGatewaySessionCreation, resolveCreatorSandbox } from "./operator-role-policy.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { resolveOperatorSessionCreation } from "./session-creation-provenance.js";
import { authorizeSessionAgentRun } from "./session-sharing-policy.js";

/** Leave ordinary creation attribution unchanged unless the authenticated person requires isolation. */
export function resolveSandboxedSessionCreation(
  client: Parameters<typeof resolveOperatorSessionCreation>[0],
  cfg: OpenClawConfig,
): ReturnType<typeof resolveOperatorSessionCreation> | undefined {
  const creation = resolveOperatorSessionCreation(client);
  return resolveCreatorSandbox(cfg, creation) === "required"
    ? { ...creation, sandbox: "required" }
    : undefined;
}

/** Binds create-on-run provenance and row admission to the original operator. */
export function prepareGatewayOperatorSessionRun(params: {
  authority: AdmittedRunOperatorAuthority;
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  currentSource: () => {
    abortSignal?: AbortSignal;
    assertSourceCurrent?: SessionSourceAssertion;
  };
}) {
  assertAdmittedRunOperatorAuthority(params.authority);
  const source = createDynamicSessionSourceAssertion(
    () => params.currentSource().assertSourceCurrent,
    () => {
      throw createSessionWorkStartChangedError(params.sessionKey);
    },
  );
  const assertCurrent = composeSessionSourceAssertion(
    [source, params.authority.assertCurrent],
    (assertSources) => {
      params.currentSource().abortSignal?.throwIfAborted();
      assertSources();
    },
  );
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
