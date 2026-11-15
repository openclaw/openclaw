import { describe, expect, it, vi } from "vitest";
import { GatewayOperatorAccessUnavailableError } from "../infra/operator-authority-error.js";
import type { PluginGatewayAccessPolicy } from "../plugins/gateway-access-policy.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { setCanonicalUserProfileDisplayName } from "../state/user-profile-writes.js";
import { linkEmail, syncGitHubIdentity } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { publishOperatorRoleConfigChange } from "./operator-role-policy.js";
import {
  expectCurrent,
  expectRevoked,
  recoveryFixture,
  restoreFixture,
} from "./operator-run-recovery.test-support.js";

describe("recovered access policy", () => {
  it.each([
    "signal",
    "assertion",
    "new policy",
    "github binding",
    "policy callback",
    "unavailable",
    "unavailable publication",
  ] as const)(
    "resumes the original access grant once and fences retained recovery through %s",
    (revocation) =>
      withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const original = { pluginId: "recovery-access", grantId: "original-accepted-grant" };
        let permitted = true;
        let additionalApplicable = false;
        let invalidateDuringPolicy = false;
        let unavailable = false;
        const controller = new AbortController();
        const grant = {
          grantId: original.grantId,
          signal: controller.signal,
          assertCurrent: () => {
            controller.signal.throwIfAborted();
            if (unavailable) {
              throw new GatewayOperatorAccessUnavailableError();
            }
            if (!permitted) {
              throw new Error("Original grant revoked");
            }
          },
        };
        const resume = vi.fn<NonNullable<PluginGatewayAccessPolicy["resume"]>>(({ profile }) =>
          permitted && (revocation !== "github binding" || profile.githubAccountIds?.includes(42))
            ? grant
            : undefined,
        );
        const registry = createEmptyPluginRegistry();
        registry.plugins.push(createPluginRecord({ id: original.pluginId }));
        registry.gatewayAccessPolicies.push({
          pluginId: original.pluginId,
          source: "fixture",
          policy: { authorize: () => grant, resume },
        });
        registry.plugins.push(createPluginRecord({ id: "additional-access" }));
        registry.gatewayAccessPolicies.push({
          pluginId: "additional-access",
          source: "fixture",
          policy: {
            authorize: () => {
              if (invalidateDuringPolicy) {
                permitted = false;
              }
              return additionalApplicable ? grant : undefined;
            },
          },
        });
        const previous = captureActivePluginRegistrySnapshot();
        stageActivePluginRegistry(registry, null, "default");
        try {
          const profile = ensureProfileForEmail("access@example.test");
          if (revocation === "github binding") {
            for (const [accountId, login, email] of [
              [41, "primary", "access@example.test"],
              [42, "secondary", "secondary@example.test"],
            ] as const) {
              syncGitHubIdentity({
                identity: { accountId, login },
                authenticationAlias: { kind: "email", email },
              });
            }
            linkEmail("secondary@example.test", profile.id);
          }
          const fixture = await recoveryFixture(state.stateDir, profile.id, {
            gatewayAccessGrant: original,
          });
          permitted = false;
          await expect(fixture.restore()).rejects.toThrow("[access-cause=grant-revoked]");
          permitted = true;
          resume.mockClear();
          using restored = await restoreFixture(fixture);

          expect(restored.authority.gatewayAccessGrant).toEqual(original);
          expect(resume).toHaveBeenCalledWith(
            expect.objectContaining({ grantId: original.grantId }),
          );
          restored.authority.assertCurrent();
          restored.authority.readCurrentRoleFacts?.();
          expect(resume).toHaveBeenCalledTimes(1);
          if (revocation.startsWith("unavailable")) {
            unavailable = true;
            if (revocation === "unavailable publication") {
              publishOperatorRoleConfigChange(fixture.context);
            }
            expect(restored.authority.assertCurrent).toThrow(GatewayOperatorAccessUnavailableError);
            expect(restored.authority.signal?.aborted).toBe(false);
            unavailable = false;
            expectCurrent(restored.authority);
            controller.abort(new Error("Original grant revoked"));
          }
          if (revocation === "signal") {
            controller.abort(new Error("Original grant revoked"));
            expect(restored.authority.signal?.aborted).toBe(true);
          } else if (revocation === "assertion") {
            permitted = false;
          } else if (revocation === "policy callback") {
            invalidateDuringPolicy = true;
          } else if (revocation === "github binding") {
            const { db } = openOpenClawStateDatabase();
            // Seed a removed secondary identity, then publish through the profile writer.
            db.prepare(
              "DELETE FROM user_profile_identities WHERE provider = 'github' AND subject = ?",
            ).run("42");
            await setCanonicalUserProfileDisplayName(profile.id, "Updated display");
          } else {
            additionalApplicable = true;
          }
          expectRevoked(restored.authority);
        } finally {
          restoreActivePluginRegistrySnapshot(previous);
        }
      }),
  );
});
