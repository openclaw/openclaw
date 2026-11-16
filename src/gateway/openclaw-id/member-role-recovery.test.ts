import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { captureAgentTurnPrincipal } from "../agent-turn/principal.js";
import { publishOperatorRoleConfigChange } from "../operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { recoveryFixture } from "../operator-run-recovery.test-support.js";
import { setOpenClawIdTunnelPrincipalLookup } from "./tunnel-principal.js";

it.each(["edited", "deleted"])(
  "revokes retained and recovered member work when its definition is %s",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
      const profile = ensureProfileForEmail("member-role@example.test");
      const principal = {
        kind: "member" as const,
        peerKey: `iroh:${"ab".repeat(32)}`,
        accountId: "member",
        role: "operator",
        authority: { clawId: "claw", rootPub: "root", listedSeq: 1 },
      };
      const config: OpenClawConfig = {
        gateway: {
          roles: {
            definitions: {
              operator: { sessions: { others: "write" }, agents: "*", scopes: ["operator.write"] },
              viewer: {
                sessions: { others: "view" },
                agents: "*",
                scopes: ["operator.sessions.read"],
              },
            },
          },
        },
      };
      setRuntimeConfigSnapshot(config);
      setOpenClawIdTunnelPrincipalLookup(() => principal);
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
        const restored = await fixture.restore();
        try {
          retained.authority.assertCurrent();
          restored.authority.assertCurrent();
          const next = structuredClone(config);
          if (change === "edited") {
            next.gateway!.roles!.definitions.operator!.scopes = ["operator.sessions.read"];
          } else {
            delete next.gateway!.roles!.definitions.operator;
          }
          fixture.setConfig(next);
          setRuntimeConfigSnapshot(next);
          publishOperatorRoleConfigChange(fixture.context);
          expect(retained.authority.signal?.aborted).toBe(true);
          expect(restored.authority.signal?.aborted).toBe(true);
          expect(retained.authority.assertCurrent).toThrow();
          expect(restored.authority.assertCurrent).toThrow();
          await expect(fixture.restore()).rejects.toThrow();
          fixture.setConfig(config);
          setRuntimeConfigSnapshot(config);
          expect(retained.authority.assertCurrent).toThrow();
        } finally {
          retained.release();
          restored.release();
        }
      } finally {
        setOpenClawIdTunnelPrincipalLookup(undefined);
      }
    });
  },
);
