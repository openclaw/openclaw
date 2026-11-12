// A linked owner device (OCF-510) is the Gateway owner attributed to a person. Retained work,
// resumed access grants and personal skill-library permissions derive from its owner
// certificate, not the person's named role, and only while that certificate is current.
// Session skill seeding is covered in server-methods/skills-library-linked-owner.test.ts.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSkillLibraryActorFromProfile } from "../../skills/library/store.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resumeGatewayOperatorAccessGrant } from "../operator-access-policy.js";
import {
  invalidateOperatorRolePolicy,
  resolveOperatorRolePolicy,
} from "../operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { currentPersonalProfileClient } from "../server-methods/personal-profile-authorization.js";
import type { GatewayRequestHandlerOptions } from "../server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { dispatchProfile } from "../server/client-fixtures.test-support.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import {
  currentOwnerDevicePrincipal,
  setOpenClawIdTunnelPrincipalLookup,
  type OpenClawIdTunnelPrincipal,
} from "./tunnel-principal.js";

const OWNER: OpenClawIdTunnelPrincipal = { kind: "owner", peerKey: `iroh:${"2b".repeat(32)}` };
const cfg: OpenClawConfig = {
  gateway: {
    roles: {
      default: "talker",
      definitions: {
        talker: {
          scopes: ["operator.talk"],
          agents: [],
          sessions: { others: "none" },
          accessPolicyPlugin: "fixture-policy",
        },
      },
    },
  },
};
let ownerCurrent = true;

beforeEach(() => {
  ownerCurrent = true;
  setOpenClawIdTunnelPrincipalLookup((peerKey) =>
    ownerCurrent && peerKey === OWNER.peerKey ? OWNER : undefined,
  );
});

afterEach(() => {
  setOpenClawIdTunnelPrincipalLookup(undefined);
});

function dispatchClient(principal?: OpenClawIdTunnelPrincipal) {
  const authority = createAdmittedRunOperatorAuthority({
    profileId: "person",
    ...(principal ? { openclawIdPrincipal: principal } : {}),
    scopes: ["operator.admin"],
    assertCurrent: () => {},
    readCurrentRoleFacts: () => ({ assignedRole: null }),
  });
  // The same synthetic operator client tool dispatch builds from an admitted run.
  return createSyntheticPluginRuntimeClient({
    operatorRoleActor: { kind: "operator", profileId: "person" },
    operatorRunAuthority: authority,
    scopes: ["operator.admin"],
  });
}

describe("linked owner device authority", () => {
  it("dispatches a linked owner's run without the person's role", () => {
    expect(resolveOperatorRolePolicy(dispatchClient(OWNER), cfg)).toBeUndefined();
    expect(resolveOperatorRolePolicy(dispatchClient(), cfg)?.scopes).toEqual(["operator.talk"]);
    ownerCurrent = false;
    expect(() => resolveOperatorRolePolicy(dispatchClient(OWNER), cfg)).toThrow(
      "OpenClaw ID membership authority changed",
    );
  });

  it("resumes a linked owner's grantless work without the person's access policy", () => {
    const profile = { profileId: "person", emails: [], assignedRole: null };
    expect(resumeGatewayOperatorAccessGrant(profile, cfg, null, undefined, OWNER)).toBeUndefined();
    expect(() => resumeGatewayOperatorAccessGrant(profile, cfg, null)).toThrow();
  });

  it("lifts the skill-library role ceiling only for the owner device's own profile", () => {
    const person = { id: "person", role: null, githubLogin: null };
    const owner = { profileId: "person", scopes: ["operator.admin"], ownerDevice: true };
    expect(resolveSkillLibraryActorFromProfile(owner, cfg, person)).toMatchObject({
      admin: true,
      read: true,
      write: true,
    });
    expect(
      resolveSkillLibraryActorFromProfile({ ...owner, ownerDevice: undefined }, cfg, person),
    ).toMatchObject({ admin: false, read: false, write: false });
    expect(
      resolveSkillLibraryActorFromProfile({ ...owner, profileId: "someone-else" }, cfg, person),
    ).toMatchObject({ admin: false, read: false, write: false });
  });

  it("recognizes only a real socket with a current owner certificate", () => {
    const socket = { connId: "c1", internal: { openclawIdPrincipal: OWNER } };
    expect(currentOwnerDevicePrincipal(socket)).toBe(OWNER);
    expect(
      currentOwnerDevicePrincipal({
        ...socket,
        internal: { ...socket.internal, syntheticClient: true },
      }),
    ).toBeUndefined();
    expect(
      currentOwnerDevicePrincipal({
        ...socket,
        internal: { ...socket.internal, remoteIngressPrincipal: {} },
      }),
    ).toBeUndefined();
    ownerCurrent = false;
    expect(currentOwnerDevicePrincipal(socket)).toBeUndefined();
  });

  it("lifts the person's role in personal APIs only while the owner certificate is current", () => {
    const socket = {
      connId: "c1",
      connect: { role: "operator", scopes: ["operator.admin"] },
      authenticatedUserProfile: { profileId: "person" },
      internal: { openclawIdPrincipal: OWNER },
    };
    const request = {
      client: socket,
      context: {
        getRuntimeConfig: () => cfg,
        getClientConnIds: (match: (candidate: unknown) => boolean) =>
          new Set(match(socket) ? [socket.connId] : []),
      },
    } as unknown as GatewayRequestHandlerOptions;
    const owner = { profileId: "person", role: null };
    expect(() => currentPersonalProfileClient(request, "operator.read", owner)).not.toThrow();
    ownerCurrent = false;
    expect(() => currentPersonalProfileClient(request, "operator.read", owner)).toThrow(
      "Personal profile requires current operator.read permission.",
    );
  });

  it("keeps a linked owner's accepted work when only the person's role changes", () =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const person = ensureProfileForEmail("linked-owner-run@example.test");
      const context = createDirectChatContext({
        getRuntimeConfig: () => ({}),
        getCommittedRuntimeConfig: () => ({}),
      });
      const capture = async (principal?: OpenClawIdTunnelPrincipal) =>
        expectDefined(
          await captureGatewayOperatorRunAuthority({
            client: {
              connId: `run-${principal?.kind ?? "person"}`,
              connectionSignal: new AbortController().signal,
              connect: {
                minProtocol: 1,
                maxProtocol: 1,
                client: {
                  id: "openclaw-control-ui",
                  version: "dev",
                  platform: "test",
                  mode: "webchat",
                },
                role: "operator",
                scopes: ["operator.admin"],
              },
              authenticatedUserProfile: dispatchProfile(person.id),
              internal: {
                authenticatedOperator: true,
                operatorRoleActor: principal
                  ? { kind: "system" }
                  : { kind: "operator", profileId: person.id },
                ...(principal ? { openclawIdPrincipal: principal } : {}),
              },
            } as unknown as GatewayWsClient,
            context,
          }),
          "captured run authority",
        );
      const owner = await capture(OWNER);
      const personal = await capture();
      invalidateOperatorRolePolicy(person.id, { roleOnly: true });
      expect(owner.authority.signal?.aborted).toBe(false);
      expect(() => owner.authority.assertCurrent()).not.toThrow();
      // The person's own work follows their role.
      expect(personal.authority.signal?.aborted).toBe(true);
      // An identity change, such as a merge, still ends the owner's attributed work.
      invalidateOperatorRolePolicy(person.id);
      expect(owner.authority.signal?.aborted).toBe(true);
      owner.release();
      personal.release();
    }));
});
