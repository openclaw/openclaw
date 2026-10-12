import { getRuntimeConfig } from "../config/io.js";
import { GatewayControlUiIngressError } from "../plugins/gateway-ingress.types.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import type { RemoteIngressPrincipalSnapshot } from "./remote-ingress-principal.js";
import { prepareSessionCreatorProfile } from "./session-creator.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { createProfileSessionEntryFilter } from "./session-sharing-read.js";
import { prepareSessionSharingRead } from "./session-sharing-target-read.js";

/** Resource tickets narrow a read; they never replace the relay's selected person. */
export async function prepareRemoteIngressSessionRead(
  principal: RemoteIngressPrincipalSnapshot | undefined,
  sessionKey: string,
  agentId?: string,
) {
  const assertIngress = () => {
    principal?.assertCurrent();
    if (principal && !authorizeOperatorScopesForMethod("chat.history", principal.scopes).allowed) {
      throw new GatewayControlUiIngressError(
        "forbidden",
        "Remote ingress does not allow session reads.",
      );
    }
  };
  assertIngress();
  if (
    !principal ||
    principal.operatorRoleActor.kind === "system" ||
    principal.scopes.includes("operator.admin")
  ) {
    return { assertCurrent: assertIngress, [Symbol.dispose]() {} };
  }
  const cfg = getRuntimeConfig();
  const agent = resolveRequestedSessionAgentId(cfg, sessionKey, agentId);
  if (!agent.ok) {
    throw new GatewayControlUiIngressError(
      "forbidden",
      "Session is not visible to this remote ingress principal.",
    );
  }
  const prepared = await prepareSessionSharingRead({ cfg, sessionKey, agentId: agent.agentId });
  const assertCurrent = () => {
    assertIngress();
    const { target } = prepared.readCurrent(getRuntimeConfig());
    const identity = principal.preparedSessionProfile;
    const visible = createProfileSessionEntryFilter(
      { profileId: identity.profileId, sessionCap: principal.operatorRolePolicy?.sessions.others },
      prepareSessionCreatorProfile(identity.profileId, identity.aliases),
    );
    if (!target || !visible(target.canonicalKey, target.entry)) {
      throw new GatewayControlUiIngressError(
        "forbidden",
        "Session is not visible to this remote ingress principal.",
      );
    }
  };
  try {
    assertCurrent();
    return { assertCurrent, [Symbol.dispose]: prepared.release };
  } catch (error) {
    prepared.release();
    throw error;
  }
}
