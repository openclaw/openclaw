import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { stateTest } from "../../plugin-state/plugin-state-fixtures.test-support.js";
import {
  prepareUserProfileCatalog,
  readUserProfileSnapshot,
} from "../../state/user-profile-list.js";
import * as profileWrites from "../../state/user-profile-writes.js";
import * as stopWork from "../chat-abort-stop-work.js";
import { readStoredClaw, writeStoredClaw } from "../openclaw-id/claw-store.js";
import { linkedClaw, serviceFor, TEST_K_SRV } from "../openclaw-id/openclaw-id.test-support.js";
import { setOpenClawIdTunnelPrincipalLookup } from "../openclaw-id/tunnel-principal.js";
import { handleGatewayRequest } from "../server-methods.js";
import {
  createContext,
  createOperatorClient,
} from "../server-plugin-in-process-dispatch.test-support.js";
import type { GatewayRequestContext } from "./types.js";
import { usersHandlers } from "./users.js";

const it = stateTest("users-member-role-persistence");

async function memberFixture() {
  const claw = await linkedClaw({ read: readStoredClaw, write: writeStoredClaw });
  const member = await profileWrites.ensureCanonicalUserProfileForOpenClawIdIdentity({
    accountId: "acct-member",
    email: "member@example.test",
  });
  expect(
    await claw.authority.submit(
      await claw.sign({
        op: "add",
        account_id: "acct-member",
        role: "operator",
        peer_keys: [TEST_K_SRV],
        invite_id: null,
      }),
      "tunnel",
    ),
  ).toMatchObject({ ok: true });
  const other = await profileWrites.ensureCanonicalUserProfileForEmail("other@example.test");
  const { service } = serviceFor(claw.authority);
  const context = createContext([], () => ({
    gateway: {
      roles: {
        default: "reader",
        definitions: {
          reader: { agents: "*", scopes: ["operator.read"], sessions: { others: "none" } },
        },
      },
    },
  }));
  context.openclawIdService = service;
  context.disconnectClientsForUserProfile = vi.fn();
  return { authority: claw.authority, member, other, service, context };
}

function setRole(context: GatewayRequestContext, profileId: string, role: string | null) {
  const respond = vi.fn();
  const request = handleGatewayRequest({
    req: { type: "req", id: "set-role", method: "users.setRole", params: { profileId, role } },
    context,
    respond,
    client: createOperatorClient({
      profileId: GATEWAY_OWNER_PROFILE_ID,
      scopes: ["operator.admin"],
    }),
    isWebchatConnect: () => false,
    extraHandlers: usersHandlers,
  });
  return { respond, request };
}

const role = (
  sessions: GatewayOperatorRoleDefinition["sessions"],
  scopes: GatewayOperatorRoleDefinition["scopes"] = ["operator.read", "operator.write"],
): GatewayOperatorRoleDefinition => ({ agents: ["main"], scopes, sessions });

const cfg: OpenClawConfig = {
  gateway: {
    roles: {
      default: "viewer",
      assignments: { byGithubLogin: { carol: "writer" } },
      definitions: {
        none: role({ others: "none" }),
        viewer: role({ others: "view" }),
        writer: role({ others: "write" }),
        invitedSend: role({ others: "invited", maxInvitedAccess: "send" }),
        invitedRead: role({ others: "invited", maxInvitedAccess: "read" }),
        invitedUncapped: role({ others: "invited" }),
        invitedSendExec: role({
          others: "invited",
          maxInvitedAccess: "send",
          invitedTools: ["read", "exec"],
        }),
        reader: role({ others: "view" }, ["operator.read"]),
      },
    },
  },
};

it.for([
  ["none", "viewer", false],
  ["viewer", "writer", false],
  ["invitedRead", "invitedSend", false],
  ["invitedSend", "writer", false],
  // Invited tool limits apply to the next request, in either direction.
  ["invitedSend", "invitedSendExec", false],
  ["invitedSend", "invitedUncapped", false],
  ["invitedUncapped", "invitedRead", true],
  // Without a ceiling a member's stored level is ignored; any ceiling applies it, so a member
  // stored at read drops to read.
  ["invitedUncapped", "invitedSend", true],
  ["viewer", "viewer", false],
  ["viewer", "none", true],
  ["invitedSend", "invitedRead", true],
  ["invitedSend", "viewer", true],
  ["viewer", "reader", true],
  // An unassigned GitHub-linked profile is a writer; clearing an explicit writer keeps that role.
  [null, "viewer", true],
  ["writer", null, false],
] as const)("%s -> %s stops work: %s", async ([before, after, expected], { state }) => {
  state.applyEnv();
  const { id: profileId } = await profileWrites.syncCanonicalGitHubIdentity({
    identity: { accountId: 42, login: "carol" },
    authenticationAlias: { kind: "github-login", login: "carol" },
  });
  await profileWrites.setCanonicalUserProfileRole(profileId, before);
  const context = createContext([], () => cfg);
  using stopped = vi.spyOn(stopWork, "stopWorkStartedBy");
  const { request, respond } = setRole(context, profileId, after);
  await request;
  expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
    profile: expect.objectContaining({ id: profileId }),
  });
  if (expected) {
    expect(stopped).toHaveBeenCalledExactlyOnceWith(context, {
      profileId,
      stopReason: "access-reduced",
    });
  } else {
    expect(stopped).not.toHaveBeenCalled();
  }
});

it("does not redirect a role assignment through a profile merge during its write", async ({
  state,
}) => {
  state.applyEnv();
  const { authority, member, other, service, context } = await memberFixture();
  const entered = createDeferred();
  const release = createDeferred();
  const write = profileWrites.setCanonicalUserProfileRole;
  using pausedWrite = vi.spyOn(profileWrites, "setCanonicalUserProfileRole");
  pausedWrite.mockImplementation(async (...args) => {
    entered.resolve();
    await release.promise;
    return write(...args);
  });
  const [source, target] = [other, member];
  const pending = setRole(context, source.id, "reader");
  try {
    try {
      await awaitGateBeforeSettlement(entered.promise, pending.request, "role request settled");
      await profileWrites.mergeCanonicalUserProfiles(source.id, target.id);
    } finally {
      release.resolve();
      await pending.request;
    }
    expect(pending.respond).toHaveBeenCalledExactlyOnceWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: "Target profile changed; retry the role assignment.",
      }),
    );
    expect(await authority.memberProfiles(["acct-member"])).toMatchObject({
      "acct-member": { id: target.id },
    });
    const snapshot = await readUserProfileSnapshot();
    const persisted = expectDefined(
      snapshot.profiles.find(({ id }) => id === target.id),
      "merged target profile",
    );
    expect(persisted.role).toBe("operator");
    expect(context.disconnectClientsForUserProfile).not.toHaveBeenCalled();
  } finally {
    await service.stop();
  }
});

it("allows assigning and clearing member and nonmember profile roles", async ({ state }) => {
  state.applyEnv();
  const { member, other, service, context } = await memberFixture();
  try {
    await profileWrites.setCanonicalUserProfileRole(member.id, "reader");
    for (const [profileId, role, disconnects] of [
      [other.id, "reader", 1],
      [other.id, null, 2],
      [member.id, "reader", 2],
      [member.id, null, 3],
    ] as const) {
      const pending = setRole(context, profileId, role);
      await pending.request;
      expect(pending.respond).toHaveBeenCalledExactlyOnceWith(true, {
        profile: expect.objectContaining({ id: profileId }),
      });
      const snapshot = await readUserProfileSnapshot();
      const persisted = expectDefined(
        snapshot.profiles.find(({ id }) => id === profileId),
        "role assignment target profile",
      );
      expect(persisted.role ?? null).toBe(role);
      expect(context.disconnectClientsForUserProfile).toHaveBeenCalledTimes(disconnects);
    }
  } finally {
    await service.stop();
  }
});

it("uses member administrator authority without changing named-role callers", async ({ state }) => {
  state.applyEnv();
  const { member, other, service, context } = await memberFixture();
  const config = context.getRuntimeConfig();
  config.gateway!.roles!.definitions.admin = {
    scopes: ["operator.admin"],
    agents: "*",
    sessions: { others: "write" },
  };
  context.getRuntimeConfig = () => config;
  setRuntimeConfigSnapshot(config);
  const principal = {
    kind: "member" as const,
    peerKey: `iroh:${"ab".repeat(32)}`,
    accountId: "acct-member",
    role: "admin",
  };
  setOpenClawIdTunnelPrincipalLookup(() => principal);
  const namedAdmin = await profileWrites.ensureCanonicalUserProfileForEmail("admin@example.test");
  await profileWrites.setCanonicalUserProfileRole(namedAdmin.id, "admin");
  const catalog = await prepareUserProfileCatalog();
  try {
    for (const [profileId, membership, allowed] of [
      [member.id, "admin", true],
      [member.id, "reader", false],
      [namedAdmin.id, null, true],
      [member.id, null, false],
      [GATEWAY_OWNER_PROFILE_ID, null, true],
    ] as const) {
      principal.role = "display-label";
      await profileWrites.setCanonicalUserProfileRole(member.id, membership);
      const client = createOperatorClient({ profileId, scopes: ["operator.admin"] });
      if (membership) {
        client.internal = { openclawIdPrincipal: principal };
      }
      const respond = vi.fn();
      await handleGatewayRequest({
        req: {
          type: "req",
          id: "member-admin",
          method: "users.setRole",
          params: { profileId: other.id, role: "reader" },
        },
        context,
        respond,
        client,
        isWebchatConnect: () => false,
        extraHandlers: usersHandlers,
      });
      expect(respond.mock.calls[0]?.[0], `${profileId}:${membership}`).toBe(allowed);
    }
  } finally {
    catalog.release();
    setOpenClawIdTunnelPrincipalLookup(undefined);
    clearRuntimeConfigSnapshot();
    await service.stop();
  }
});
