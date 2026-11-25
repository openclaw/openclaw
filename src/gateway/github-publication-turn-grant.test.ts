// Install the existing synthetic GitHub transport before loading publication owners.
// oxfmt-ignore
import {
  createPublicationActionFixture,
  withPublicationToolTransport,
} from "./github-publication-actions.test-support.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { createGitHubPublishTool } from "../agents/tools/github-publish-tool.js";
import type { InProcessGatewayCaller } from "../agents/tools/in-process-gateway.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { linkUserChannelIdentity } from "../state/user-channel-identities.js";
import { ensureCanonicalUserProfileForEmail } from "../state/user-profile-writes.js";
import { ensureGatewayOwnerProfile } from "../state/user-profiles.js";
import {
  installGitHubPublicationTestHarness,
  SESSION_KEY,
} from "./github-publication.test-support.js";
import { resolveLeastPrivilegeOperatorScopesForMethod } from "./method-scopes.js";
import {
  decideChannelOwnerPrincipal,
  prepareChannelSenderAdmission,
} from "./operator-admission.js";
import {
  captureChannelOperatorRunAuthority,
  prepareGatewayOperatorRunAuthority,
} from "./operator-run-authority.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { createOperatorWsClient } from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import { prepareGatewayConnectOperatorAccess } from "./server/ws-connection/connect-operator-access.js";

type Fixture = Awaited<ReturnType<typeof createPublicationActionFixture>>;
type Principal = "owner" | "admin" | "member" | "guest";
type Entry = "control-ui" | "discord-owner" | "telegram-owner" | "linked-channel";
type Outcome = "ok" | "refused";

// github_publish takes its rights from the calling turn's grant (MATRIX P column): owner and admin
// write, the member its own session's PR, the guest nothing. The session's PR belongs to the member.
const EXPECTED: Record<Principal, Record<"inspect" | "edit" | "merge", Outcome>> = {
  owner: { inspect: "ok", edit: "ok", merge: "ok" },
  admin: { inspect: "ok", edit: "ok", merge: "ok" },
  member: { inspect: "refused", edit: "ok", merge: "refused" },
  guest: { inspect: "refused", edit: "refused", merge: "refused" },
};
const CELLS: [Principal, Entry][] = [
  ["owner", "control-ui"],
  ["owner", "discord-owner"],
  ["owner", "telegram-owner"],
  ["admin", "control-ui"],
  ["admin", "linked-channel"],
  ["member", "control-ui"],
  ["member", "linked-channel"],
  ["guest", "control-ui"],
  ["guest", "linked-channel"],
];

async function admitTurn(
  f: Fixture,
  principal: Principal,
  entry: Entry,
): Promise<AdmittedRunOperatorAuthority | undefined> {
  const config = { ...f.config, commands: { ownerAllowFrom: ["discord:111", "telegram:222"] } };
  setRuntimeConfigSnapshot(config);
  const getRuntimeConfig = () => config;
  if (entry === "discord-owner" || entry === "telegram-owner") {
    const sender =
      entry === "discord-owner"
        ? { channelId: "discord", accountId: "default", senderId: "111" }
        : { channelId: "telegram", accountId: "default", senderId: "222" };
    const admitted = decideChannelOwnerPrincipal(config, sender);
    return admitted && captureChannelOperatorRunAuthority({ ...admitted, getRuntimeConfig });
  }
  const profileId =
    principal === "admin"
      ? f.maintainerProfile
      : principal === "member"
        ? f.guestProfile
        : principal === "guest"
          ? (await ensureCanonicalUserProfileForEmail("publication-viewer@example.test")).id
          : GATEWAY_OWNER_PROFILE_ID;
  if (entry === "linked-channel") {
    const identity = { channelId: "discord", accountId: "default", senderId: randomUUID() };
    linkUserChannelIdentity(profileId, identity);
    const prepared = await prepareChannelSenderAdmission(
      { ...identity, authentication: "verified" },
      getRuntimeConfig,
    );
    const operator = prepared.operatorAuthority;
    return (
      operator &&
      captureChannelOperatorRunAuthority({
        ...operator.operatorProfile,
        recoveryReference: operator.recoveryReference,
        getRuntimeConfig,
      })
    );
  }
  const client = createOperatorWsClient({
    connId: profileId,
    scopes:
      principal === "guest"
        ? ["operator.sessions.read"]
        : principal === "member"
          ? ["operator.sessions.read", "operator.sessions.write"]
          : ["operator.admin"],
  });
  client.authenticatedUserProfile = {
    profileId,
    displayName: null,
    avatarRevision: "fixture",
    hasAvatar: false,
    updatedAt: 1,
  };
  if (principal === "owner") {
    client.internal = {
      ...client.internal,
      authenticatedOperator: true,
      operatorRoleActor: { kind: "system" },
    };
  }
  prepareGatewayConnectOperatorAccess(client);
  const prepared = await prepareGatewayOperatorRunAuthority({
    client,
    context: { getRuntimeConfig, getCommittedRuntimeConfig: getRuntimeConfig },
  });
  onTestFinished(() => prepared?.release());
  return prepared?.authority;
}

// The agent tool reaches the Gateway as the in-process System client with the method's least
// scopes, carrying the turn's admitted authority (server-plugin-in-process-authority.ts).
async function callAsTurn(
  f: Fixture,
  authority: AdmittedRunOperatorAuthority | undefined,
  args: Record<string, unknown>,
): Promise<Outcome> {
  const context = {
    ...f.maintainerSource.context,
    githubPublicationService: f.coordinator,
  } as GatewayRequestContext;
  const callGateway: InProcessGatewayCaller = async <T>(
    method: string,
    params: Record<string, unknown>,
  ) => {
    const respond = vi.fn();
    await handleGatewayRequest({
      req: { type: "req", id: randomUUID(), method, params },
      client: createSyntheticPluginRuntimeClient({
        operatorRoleActor: { kind: "system" },
        scopes: resolveLeastPrivilegeOperatorScopesForMethod(method, params),
        ...(authority ? { operatorRunAuthority: authority } : {}),
      }),
      context,
      isWebchatConnect: () => false,
      respond,
    });
    const [ok, result, error] = respond.mock.calls[0]!;
    if (!ok) {
      throw new Error(error.message);
    }
    return result as T;
  };
  return await withPublicationToolTransport(callGateway, () =>
    withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: SESSION_KEY, operatorAuthority: authority },
      async () => {
        try {
          await createGitHubPublishTool({}).execute("turn-grant", args);
          return "ok" as const;
        } catch (error) {
          // A GitHub-side rejection proves the Gateway admitted the action.
          if (String(error).includes("Required checks have not passed")) {
            return "ok" as const;
          }
          return "refused" as const;
        }
      },
    ),
  );
}

describe("github_publish rights come from the calling turn's grant", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: "publication-guest@example.test",
    sandbox: "required",
    realWorktree: true,
  });

  it.each(CELLS)("%s x %s", async (principal, entry) => {
    const f = await createPublicationActionFixture();
    ensureGatewayOwnerProfile(null);
    const authority = await admitTurn(f, principal, entry);
    f.rejectMerge();
    f.state.draft = false;
    const outcome = {
      inspect: await callAsTurn(f, authority, { action: "inspect" }),
      edit: await callAsTurn(f, authority, {
        action: "edit",
        ...f.expected,
        title: f.state.title,
        expectedTitle: f.state.title,
      }),
      merge: await callAsTurn(f, authority, {
        action: "merge",
        mergeMethod: "squash",
        ...f.expected,
      }),
    };
    expect(outcome, `${principal} x ${entry}`).toEqual(EXPECTED[principal]);
  });
});
