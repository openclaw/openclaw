import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it } from "vitest";
import {
  assertOperatorAccessProgramAllowed,
  bindOperatorModelExecution,
} from "../agents/admitted-run-context.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareOperatorModelPresentation } from "./operator-model-presentation.js";
import { publishOperatorRoleConfigChange } from "./operator-role-policy.js";
import {
  captureChannelOperatorRunAuthority,
  captureGatewayOperatorRunAuthority,
} from "./operator-run-authority.js";
import { recoveryFixture } from "./operator-run-recovery.test-support.js";
import {
  createContext,
  createOperatorClient,
} from "./server-plugin-in-process-dispatch.test-support.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

type Grants = NonNullable<GatewayOperatorRoleDefinition["accessPrograms"]>["cyber"];
function config(
  cyber: Grants | undefined,
  scopes: GatewayOperatorRoleDefinition["scopes"] = ["operator.admin"],
): OpenClawConfig {
  return {
    gateway: {
      roles: {
        default: "member",
        definitions: {
          member: {
            sessions: { others: "none" },
            agents: "*",
            scopes,
            ...(cyber ? { accessPrograms: { cyber } } : {}),
          },
        },
      },
    },
  };
}

it.each<{
  scope: GatewayOperatorRoleDefinition["scopes"][number];
  grants: Grants | undefined;
  allowed: Grants;
}>([
  { scope: "operator.admin", grants: undefined, allowed: ["daybreak_blue", "daybreak_red"] },
  { scope: "operator.write", grants: undefined, allowed: [] },
  { scope: "operator.admin", grants: [], allowed: [] },
  { scope: "operator.write", grants: ["daybreak_blue"], allowed: ["daybreak_blue"] },
  { scope: "operator.admin", grants: ["daybreak_red"], allowed: ["daybreak_red"] },
  {
    scope: "operator.admin",
    grants: ["daybreak_blue", "daybreak_red"],
    allowed: ["daybreak_blue", "daybreak_red"],
  },
])(
  "applies $scope authority with Access ceiling $grants without restricting ordinary models",
  ({ scope, grants, allowed }) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForEmail("access-role@example.test");
      const scopes = [scope];
      const client = createOperatorClient({ profileId: profile.id, scopes });
      const context = createContext();
      let cfg = config(grants, scopes);
      context.getRuntimeConfig = () => cfg;
      const captured = expectDefined(
        await captureGatewayOperatorRunAuthority({ client, context }),
        "captured source",
      );
      using _ = { [Symbol.dispose]: captured.release };
      const channel = captureChannelOperatorRunAuthority({
        profileId: profile.id,
        assignedRole: null,
        scopes,
        gatewayAccessGrant: null,
        getRuntimeConfig: context.getRuntimeConfig,
        assertCurrent: captured.authority.assertCurrent,
      });
      const programs = ["standard", "daybreak_blue", "daybreak_red"] as const;
      for (const authority of [captured.authority, channel]) {
        expect(authority.modelPolicy).toBeUndefined();
        for (const program of programs) {
          const check = () => assertOperatorAccessProgramAllowed(authority, program);
          if (program === "standard" || allowed.includes(program)) {
            expect(check).not.toThrow();
          } else {
            expect(check).toThrow("operator role cannot use this Access level");
          }
        }
      }
      const presentation = expectDefined(
        prepareOperatorModelPresentation({ cfg, policyConfig: cfg, client }),
        "role presentation",
      );
      const catalog = presentation.forAgent("main").catalog({
        models: [
          {
            provider: "openai",
            id: "fixture",
            name: "Fixture",
            availableAccessPrograms: { cyber: [...programs] },
          },
        ],
      });
      expect(catalog.modelSelectionPolicy).toBeUndefined();
      expect(catalog.models[0]?.availableAccessPrograms?.cyber).toEqual(["standard", ...allowed]);
      if (allowed.includes("daybreak_blue")) {
        const execution = expectDefined(
          bindOperatorModelExecution(captured.authority, {
            provider: "openai",
            model: "fixture",
            cyberAccessProgram: "daybreak_blue",
          }),
          "execution binding",
        );
        try {
          cfg = config([], scopes);
          publishOperatorRoleConfigChange(context);
          expect(execution.signal.aborted).toBe(true);
          expect(execution.assertCurrent).toThrow();
          expect(channel.assertCurrent).toThrow();
          cfg = config(grants, scopes);
          expect(execution.assertCurrent).toThrow();
        } finally {
          execution.release();
        }
      }
    }),
);

it("does not acquire admin execution authority from a privileged internal adapter", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const profile = ensureProfileForEmail("access-adapter@example.test");
    const client = createOperatorClient({ profileId: profile.id, scopes: ["operator.write"] });
    const cfg = config(undefined);
    const context = createContext();
    context.getRuntimeConfig = () => cfg;
    const captured = expectDefined(
      await captureGatewayOperatorRunAuthority({ client, context }),
      "original requester",
    );
    using _ = { [Symbol.dispose]: captured.release };
    const adapter = createSyntheticPluginRuntimeClient({
      scopes: ["operator.admin"],
      operatorRoleActor: { kind: "operator", profileId: profile.id },
      operatorRunAuthority: captured.authority,
    });
    const child = expectDefined(
      await captureGatewayOperatorRunAuthority({ client: adapter, context }),
      "child requester",
    );
    using childHold = { [Symbol.dispose]: child.release };
    void childHold;
    expect(() => assertOperatorAccessProgramAllowed(child.authority, "daybreak_blue")).toThrow(
      "operator role cannot use this Access level",
    );
    const presentation = expectDefined(
      prepareOperatorModelPresentation({ cfg, policyConfig: cfg, client: adapter }),
      "adapter presentation",
    );
    expect(
      presentation.forAgent("main").catalog({
        models: [
          {
            provider: "openai",
            id: "fixture",
            name: "Fixture",
            availableAccessPrograms: { cyber: ["standard", "daybreak_blue", "daybreak_red"] },
          },
        ],
      }).models[0]?.availableAccessPrograms?.cyber,
    ).toEqual(["standard"]);
  }));

it.each<{ grants: Grants | undefined }>([{ grants: undefined }, { grants: ["daybreak_blue"] }])(
  "retains scheduled Access authority with ceiling $grants but rejects a changed snapshot",
  ({ grants }) =>
    withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
      const profile = ensureProfileForEmail("access-recovery@example.test");
      const fixture = await recoveryFixture(stateDir, profile.id, {
        config: config(grants),
      });
      expect(fixture.snapshot.rolePolicy?.accessPrograms).toEqual(
        grants ? { cyber: grants } : undefined,
      );
      const restored = expectDefined(await fixture.restore(), "restored source");
      using _ = { [Symbol.dispose]: restored.release };
      expect(() =>
        assertOperatorAccessProgramAllowed(restored.authority, "daybreak_blue"),
      ).not.toThrow();
      const red = () => assertOperatorAccessProgramAllowed(restored.authority, "daybreak_red");
      if (grants) {
        expect(red).toThrow();
      } else {
        expect(red).not.toThrow();
      }
      fixture.setConfig(config([]));
      expect(restored.authority.assertCurrent).toThrow();
      await expect(fixture.restore()).rejects.toThrow();
    }),
);
