// A linked owner device (OCF-510) is the Gateway owner attributed to a person. Retained work,
// resumed access grants and personal skill-library permissions derive from its owner
// certificate, not the person's named role, and only while that certificate is current.
// Stored-role changes and session skill seeding need the host database broker; they are
// covered in server-methods/linked-owner-authority.test.ts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSkillLibraryActorFromProfile } from "../../skills/library/store.js";
import { resumeGatewayOperatorAccessGrant } from "../operator-access-policy.js";
import { resolveOperatorRolePolicy } from "../operator-role-policy.js";
import { currentPersonalProfileClient } from "../server-methods/personal-profile-authorization.js";
import type { GatewayRequestHandlerOptions } from "../server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
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
});
