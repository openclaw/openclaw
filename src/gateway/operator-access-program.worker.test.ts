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

type Grants = NonNullable<GatewayOperatorRoleDefinition["accessPrograms"]>["cyber"];
function config(cyber: Grants | undefined): OpenClawConfig {
  return {
    gateway: {
      roles: {
        default: "member",
        definitions: {
          member: {
            sessions: { others: "none" },
            agents: "*",
            scopes: ["operator.admin"],
            ...(cyber ? { accessPrograms: { cyber } } : {}),
          },
        },
      },
    },
  };
}

it.each<{ grants: Grants | undefined }>([
  { grants: undefined },
  { grants: [] },
  { grants: ["daybreak_blue"] },
  { grants: ["daybreak_red"] },
  { grants: ["daybreak_blue", "daybreak_red"] },
])(
  "applies explicit Access grants $grants to admin-scoped roles without restricting ordinary models",
  ({ grants }) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForEmail("access-role@example.test");
      const client = createOperatorClient({ profileId: profile.id, scopes: ["operator.admin"] });
      const context = createContext();
      let cfg = config(grants);
      context.getRuntimeConfig = () => cfg;
      const captured = expectDefined(
        await captureGatewayOperatorRunAuthority({ client, context }),
        "captured source",
      );
      using _ = { [Symbol.dispose]: captured.release };
      const channel = captureChannelOperatorRunAuthority({
        profileId: profile.id,
        assignedRole: null,
        scopes: ["operator.admin"],
        gatewayAccessGrant: null,
        getRuntimeConfig: context.getRuntimeConfig,
        assertCurrent: captured.authority.assertCurrent,
      });
      const programs = ["standard", "daybreak_blue", "daybreak_red"] as const;
      for (const authority of [captured.authority, channel]) {
        expect(authority.modelPolicy).toBeUndefined();
        for (const program of programs) {
          const check = () => assertOperatorAccessProgramAllowed(authority, program);
          if (program === "standard" || grants?.includes(program)) {
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
      expect(catalog.models[0]?.availableAccessPrograms?.cyber).toEqual([
        "standard",
        ...(grants ?? []),
      ]);
      if (grants?.includes("daybreak_blue")) {
        const execution = expectDefined(
          bindOperatorModelExecution(captured.authority, {
            provider: "openai",
            model: "fixture",
            cyberAccessProgram: "daybreak_blue",
          }),
          "execution binding",
        );
        try {
          cfg = config([]);
          publishOperatorRoleConfigChange(context);
          expect(execution.signal.aborted).toBe(true);
          expect(execution.assertCurrent).toThrow();
          expect(channel.assertCurrent).toThrow();
          cfg = config(grants);
          expect(execution.assertCurrent).toThrow();
        } finally {
          execution.release();
        }
      }
    }),
);

it("retains explicit grants across restart but rejects a changed grant snapshot", () =>
  withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    const profile = ensureProfileForEmail("access-recovery@example.test");
    const fixture = await recoveryFixture(stateDir, profile.id, {
      config: config(["daybreak_blue"]),
    });
    expect(fixture.entry.restartRecoveryOperatorSource?.snapshot.rolePolicy).toMatchObject({
      accessPrograms: { cyber: ["daybreak_blue"] },
    });
    const restored = expectDefined(await fixture.restore(), "restored source");
    using _ = { [Symbol.dispose]: restored.release };
    expect(() =>
      assertOperatorAccessProgramAllowed(restored.authority, "daybreak_blue"),
    ).not.toThrow();
    expect(() => assertOperatorAccessProgramAllowed(restored.authority, "daybreak_red")).toThrow();
    fixture.setConfig(config([]));
    expect(restored.authority.assertCurrent).toThrow();
    await expect(fixture.restore()).rejects.toThrow();
  }));
