import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { recoveryFixture } from "./operator-run-recovery.test-support.js";

function modelRef(model: string) {
  return { provider: "fixture", model };
}

it("intersects the original model ceiling with current policy without widening the admitted role", () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const profile = ensureProfileForEmail("model@example.test");
    setUserProfileRole(profile.id, "operator");
    const operator = {
      sessions: { others: "none" },
      agents: ["main"],
      scopes: ["operator.admin"],
      sandbox: "required",
      modelPolicy: { allow: ["fixture/a", "fixture/b"] },
    } satisfies GatewayOperatorRoleDefinition;
    const cfg = {
      agents: { defaults: { model: "fixture/a" } },
      gateway: { roles: { default: "operator", definitions: { operator } } },
    } satisfies OpenClawConfig;
    const fixture = await recoveryFixture(state.stateDir, profile.id, {
      config: cfg,
    });
    const current = structuredClone(cfg);
    current.gateway.roles.definitions.operator.modelPolicy = {
      allow: ["fixture/b", "fixture/c"],
    };
    fixture.setConfig(current);
    const restored = expectDefined(await fixture.restore(), "model-restricted recovery");
    using _ = { [Symbol.dispose]: restored.release };

    expect(restored.authority.rolePolicy).toMatchObject({
      agents: ["main"],
      sandboxRequired: true,
      sessionAccessCap: "none",
    });
    expect(restored.authority.modelPolicy?.allows(modelRef("a"))).toBe(false);
    expect(restored.authority.modelPolicy?.allows(modelRef("b"))).toBe(true);
    expect(restored.authority.modelPolicy?.allows(modelRef("c"))).toBe(false);
    const widened = structuredClone(current);
    widened.gateway.roles.definitions.operator.modelPolicy = {
      allow: ["fixture/a", "fixture/b", "fixture/c"],
    };
    fixture.setConfig(widened);
    expect(restored.authority.modelPolicy?.models).toEqual([modelRef("b")]);
  }));
