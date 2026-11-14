import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { stateTest } from "../../plugin-state/plugin-state-fixtures.test-support.js";
import { readUserProfileSnapshot } from "../../state/user-profile-list.js";
import * as profileWrites from "../../state/user-profile-writes.js";
import { readStoredClaw, writeStoredClaw } from "../openclaw-id/claw-store.js";
import { createOpenClawIdConnectionAccess } from "../openclaw-id/connection-identity.js";
import { linkedClaw, serviceFor, TEST_K_SRV } from "../openclaw-id/openclaw-id.test-support.js";
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

it.for(["membership preparation", "role write"] as const)(
  "does not redirect a role assignment through a profile merge during %s",
  async (stage, { state }) => {
    state.applyEnv();
    const { authority, member, other, service, context } = await memberFixture();
    const entered = createDeferred();
    const release = createDeferred();
    Object.assign(
      service,
      createOpenClawIdConnectionAccess({
        enabled: () => true,
        getAuthority: async () => {
          if (stage === "membership preparation") {
            entered.resolve();
            await release.promise;
          }
          return authority;
        },
      }),
    );
    const write = profileWrites.setCanonicalUserProfileRole;
    using pausedWrite = vi.spyOn(profileWrites, "setCanonicalUserProfileRole");
    pausedWrite.mockImplementation(async (...args) => {
      if (stage === "role write") {
        entered.resolve();
        await release.promise;
      }
      return write(...args);
    });
    const [source, target] = stage === "membership preparation" ? [member, other] : [other, member];
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
      expect(persisted.role).toBeUndefined();
      expect(context.disconnectClientsForUserProfile).not.toHaveBeenCalled();
    } finally {
      await service.stop();
    }
  },
);

it("allows current nonmember role writes and clearing a member's stored profile role", async ({
  state,
}) => {
  state.applyEnv();
  const { member, other, service, context } = await memberFixture();
  try {
    await profileWrites.setCanonicalUserProfileRole(member.id, "reader");
    for (const [profileId, role] of [
      [other.id, "reader"],
      [other.id, null],
      [member.id, null],
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
    }
  } finally {
    await service.stop();
  }
});
