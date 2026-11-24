import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { captureAgentTurnPrincipal } from "../agent-turn/principal.js";
import {
  invalidateOperatorRolePolicy,
  publishOperatorRoleConfigChange,
} from "../operator-role-policy.js";
import { prepareGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { recoveryFixture } from "../operator-run-recovery.test-support.js";
import {
  setOpenClawIdTunnelPrincipalLookup,
  type OpenClawIdTunnelPrincipal,
} from "./tunnel-principal.js";

type Change =
  | "demote-live"
  | "demote-while-down"
  | "openclaw-id-remove"
  | "definition-edited"
  | "definition-deleted";

it.for<Change>([
  "demote-live",
  "demote-while-down",
  "openclaw-id-remove",
  "definition-edited",
  "definition-deleted",
])("recovered member work after %s", async (change) => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    const profile = ensureProfileForEmail(`member-${change}@example.test`);
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
    try {
      const fixture = await recoveryFixture(stateDir, profile.id, {
        config,
        scopes: ["operator.write"],
        openclawIdPrincipal: principal,
      });
      const retained = expectDefined(
        await prepareGatewayOperatorRunAuthority({
          client: captureAgentTurnPrincipal(fixture.client),
          context: fixture.context,
          sourceAuthority: null,
        }),
        "member authority",
      );
      const previouslyRestored = await fixture.restore();
      try {
        if (change === "demote-live") {
          setUserProfileRole(profile.id, null);
          invalidateOperatorRolePolicy(profile.id, { roleOnly: true });
        } else if (change === "demote-while-down") {
          // A role written while the Gateway is down publishes no live invalidation.
          setUserProfileRole(profile.id, null);
        } else if (change === "openclaw-id-remove") {
          listed = false;
          setOpenClawIdTunnelPrincipalLookup(() => undefined);
          expect(previouslyRestored.authority.signal?.aborted).not.toBe(true);
        } else {
          const next = structuredClone(config);
          if (change === "definition-edited") {
            next.gateway!.roles!.definitions.worker!.scopes = ["operator.read"];
          } else {
            delete next.gateway!.roles!.definitions.worker;
          }
          fixture.setConfig(next);
          setRuntimeConfigSnapshot(next);
          publishOperatorRoleConfigChange(fixture.context);
          for (const authority of [retained.authority, previouslyRestored.authority]) {
            expect(authority.signal?.aborted).not.toBe(true);
          }
        }
        // Bare captured/restored requests may finish; fresh admission uses the changed source.
        for (const authority of [retained.authority, previouslyRestored.authority]) {
          expect(authority.signal?.aborted).not.toBe(true);
        }
        await expect(fixture.restore()).rejects.toThrow();
        if (change === "definition-edited" || change === "definition-deleted") {
          for (const authority of [retained.authority, previouslyRestored.authority]) {
            expect(authority.signal?.aborted).not.toBe(true);
          }
          fixture.setConfig(config);
          setRuntimeConfigSnapshot(config);
        }
      } finally {
        retained.release();
        previouslyRestored.release();
      }
    } finally {
      setOpenClawIdTunnelPrincipalLookup(undefined);
    }
  });
});
