// Design probe (B4): recovered member work under a profile-role authority model.
// The shim reads an OpenClaw ID member's policy from its linked profile role.
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import {
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  captureResidentUserProfileAccess,
  prepareUserProfileCatalog,
} from "../../state/user-profile-list.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { captureAgentTurnPrincipal } from "../agent-turn/principal.js";
import { invalidateOperatorRolePolicy } from "../operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { recoveryFixture } from "../operator-run-recovery.test-support.js";
import {
  setOpenClawIdTunnelPrincipalLookup,
  type OpenClawIdTunnelPrincipal,
} from "./tunnel-principal.js";

const shim = vi.hoisted(() => ({ profiles: new Map<string, string>() }));

vi.mock("./tunnel-principal.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tunnel-principal.js")>();
  const memberPolicy = (principal: OpenClawIdTunnelPrincipal | undefined) => {
    const profileId =
      principal?.kind === "member" ? shim.profiles.get(principal.accountId) : undefined;
    if (!profileId) {
      return actual.openclawIdTunnelRolePolicy(principal);
    }
    const role = captureResidentUserProfileAccess(profileId).assertCurrent()?.role ?? null;
    const definitions = getRuntimeConfigSnapshot()?.gateway?.roles?.definitions ?? {};
    return role && Object.hasOwn(definitions, role)
      ? definitions[role]
      : ({ scopes: [], agents: [], sessions: { others: "none" } } as GatewayOperatorRoleDefinition);
  };
  return {
    ...actual,
    openclawIdTunnelRolePolicy: memberPolicy,
    openclawIdSubjectRolePolicy: (
      principal: OpenClawIdTunnelPrincipal | undefined,
      resolveProfileRole: () => GatewayOperatorRoleDefinition | undefined,
    ) =>
      principal?.kind === "owner" ? undefined : (memberPolicy(principal) ?? resolveProfileRole()),
  };
});

type Change = "demote-live" | "demote-while-down" | "openclaw-id-remove";

it.for<[Change, boolean]>([
  ["demote-live", true],
  ["demote-while-down", true],
  ["demote-while-down", false],
  ["openclaw-id-remove", true],
])("recovered member work after %s (profile-role shim=%s)", async ([change, useShim]) => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    const profile = ensureProfileForEmail(`member-${change}-${useShim}@example.test`);
    await prepareUserProfileCatalog();
    const principal: OpenClawIdTunnelPrincipal = {
      kind: "member",
      peerKey: `iroh:${"ab".repeat(32)}`,
      accountId: "member",
      role: "member-label",
      authority: { clawId: "claw", rootPub: "root", listedSeq: 1 },
    };
    const config: OpenClawConfig = {
      gateway: {
        roles: {
          default: "reader",
          definitions: {
            "member-label": {
              sessions: { others: "none" },
              agents: "*",
              scopes: ["operator.write"],
            },
            worker: { sessions: { others: "none" }, agents: "*", scopes: ["operator.write"] },
            reader: { sessions: { others: "none" }, agents: "*", scopes: ["operator.read"] },
          },
        },
      },
    };
    setRuntimeConfigSnapshot(config);
    let listed = true;
    setOpenClawIdTunnelPrincipalLookup(() => (listed ? principal : undefined));
    setUserProfileRole(profile.id, "worker");
    invalidateOperatorRolePolicy(profile.id, { roleOnly: true });
    shim.profiles.clear();
    if (useShim) {
      shim.profiles.set(principal.accountId, profile.id);
    }
    try {
      const fixture = await recoveryFixture(stateDir, profile.id, {
        config,
        scopes: ["operator.write"],
        openclawIdPrincipal: principal,
      });
      const retained = expectDefined(
        await captureGatewayOperatorRunAuthority({
          client: captureAgentTurnPrincipal(fixture.client),
          context: fixture.context,
          sourceAuthority: null,
        }),
        "member authority",
      );
      try {
        if (change === "demote-live") {
          setUserProfileRole(profile.id, null);
          invalidateOperatorRolePolicy(profile.id, { roleOnly: true });
          expect(retained.authority.signal?.aborted).toBe(true);
        } else if (change === "demote-while-down") {
          // A role written while the Gateway is down publishes no live invalidation.
          setUserProfileRole(profile.id, null);
        } else {
          listed = false;
        }
        const restored = await fixture.restore().then(
          (value) => {
            value.release?.();
            return "restored";
          },
          (error: unknown) => `refused: ${error instanceof Error ? error.message : String(error)}`,
        );
        // Recovery snapshots the profile's assigned role, so any change refuses, shim or not;
        // with the shim the narrowed role policy is reported first.
        expect(restored).toMatch(
          change === "openclaw-id-remove"
            ? /^refused: OpenClaw ID membership authority changed/
            : useShim
              ? /^refused: Restart recovery operator source policy changed/
              : /^refused: Restart recovery operator identity changed/,
        );
      } finally {
        retained.release();
      }
    } finally {
      setOpenClawIdTunnelPrincipalLookup(undefined);
      shim.profiles.clear();
    }
  });
});
