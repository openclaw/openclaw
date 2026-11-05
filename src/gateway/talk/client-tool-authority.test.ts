import { describe, expect, it } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import {
  prepareTalkClientToolContext,
  resolveTalkAgentConsultAuthority,
} from "./client-tool-authority.js";

const verifiedProfile = "profile-ada";
const allowFrom = { webchat: [verifiedProfile, GATEWAY_OWNER_PROFILE_ID] };
const config: OpenClawConfig = {
  tools: { elevated: { enabled: true, allowFrom } },
  agents: { entries: { main: { tools: { elevated: { enabled: true, allowFrom } } } } },
};
const scopes = ["operator.read", "operator.write"];

function prepareBashElevatedFor(authority: ReturnType<typeof resolveTalkAgentConsultAuthority>) {
  return prepareTalkClientToolContext({ config, agentId: "main", authority })?.bashElevated;
}

function prepareBashElevated(client: ReturnType<typeof sharingPolicyClient>) {
  return prepareBashElevatedFor(resolveTalkAgentConsultAuthority(client.connect.scopes, client));
}

describe("Talk client tool authority", () => {
  it.each([
    ["a verified profile", () => sharingPolicyClient({ user: verifiedProfile, scopes }), true],
    [
      "shared gateway-owner attribution",
      () => {
        const client = sharingPolicyClient({ deviceId: "talk-shared-owner", scopes });
        client.authenticatedUserProfile = {
          profileId: GATEWAY_OWNER_PROFILE_ID,
          displayName: "Owner",
          hasAvatar: false,
          updatedAt: 1,
        };
        return client;
      },
      false,
    ],
    [
      "a synthetic caller",
      () => {
        const client = sharingPolicyClient({ user: verifiedProfile, scopes });
        client.internal = { syntheticClient: true };
        return client;
      },
      false,
    ],
  ] as const)("uses the live matcher for %s", (_name, create, allowed) => {
    expect(prepareBashElevated(create())).toMatchObject({
      enabled: true,
      allowed,
      defaultLevel: allowed ? "on" : "off",
    });
  });

  it("rechecks the live reply caller before elevated bash after revocation", () => {
    const lifetime = new AbortController();
    const client = sharingPolicyClient({ user: verifiedProfile, scopes });
    client.connectionSignal = lifetime.signal;
    const authority = resolveTalkAgentConsultAuthority(client.connect.scopes, client);

    expect(prepareBashElevatedFor(authority)).toMatchObject({ enabled: true, allowed: true });
    lifetime.abort();
    expect(prepareBashElevatedFor(authority)).toMatchObject({ enabled: true, allowed: false });
  });
});
