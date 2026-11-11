import { expect, expectTypeOf, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginCache, withPluginCache } from "../../plugins/plugin-cache.js";
import {
  defineChannelSetupContract,
  resolveChannelSetupExecutionAdapter,
} from "./setup-contract.js";
import { moveSingleAccountChannelSectionToDefaultAccount } from "./setup-helpers.js";

const adapter = { applyAccountConfig: ({ cfg }: { cfg: OpenClawConfig }) => cfg };
const cli = (flags: string) => ({ flags, description: "Setup option" });
const fields = {
  token: { kind: "string", cli: cli("--token <token>") },
  transport: {
    kind: "choice",
    choices: ["external-native", "container"],
    cli: cli("--transport <kind>"),
  },
  port: { kind: "integer", cli: cli("--port <port>") },
  allowFrom: { kind: "string-list", cli: cli("--allow-from <ids>") },
  useEnv: { kind: "boolean", cli: cli("--use-env") },
} as const;

function booleanContract(key: string, flags: string, negatedFlags: string) {
  return defineChannelSetupContract({
    fields: { [key]: { kind: "boolean", cli: { flags, negatedFlags, description: "Mode" } } },
    adapter,
  });
}

it("keeps ignored aliases ineligible during cold channel-owned promotion", () => {
  const defaultAccount = "work-phone";
  const alias = { dmPolicy: "open", allowFrom: ["*"] };
  const next = withPluginCache(createPluginCache(), () =>
    moveSingleAccountChannelSectionToDefaultAccount({
      cfg: {
        channels: {
          demo: { account: "+12025550123", defaultAccount, accounts: { "Work Phone": alias } },
        },
      },
      channelKey: "demo",
      setupSurface: resolveChannelSetupExecutionAdapter({
        setupContract: defineChannelSetupContract({
          fields: {},
          adapter: {
            ...adapter,
            accountKeyPolicy: { canonicalAliasesRequireOwnField: "account" },
            singleAccountKeysToMove: ["account"],
            namedAccountPromotionKeys: ["account"],
          },
        }),
      }),
    }),
  );

  expect(next.channels?.demo).toEqual({
    defaultAccount,
    accounts: {
      "Work Phone": alias,
      default: { account: "+12025550123" },
    },
  });
});

it("requires negated flags to resolve to the same field key", () => {
  expect(() => booleanContract("tenant", "--tenant", "--no-other")).toThrow(
    'Channel setup field "tenant" must match camelCased long flag name "other"',
  );
  expect(() => booleanContract("useEnv", "--use-env", "--no-use-env")).not.toThrow();
});

it("parses channel-owned fields and gives adapters inferred input types", () => {
  const expected = {
    name: "work",
    token: "secret",
    transport: "container",
    port: 8080,
    allowFrom: ["alice", "bob"],
    useEnv: true,
  };
  const contract = defineChannelSetupContract({
    fields,
    adapter: {
      applyAccountConfig: (params) => {
        expectTypeOf(params.input.name).toEqualTypeOf<string | undefined>();
        expectTypeOf(params.input.token).toEqualTypeOf<string | undefined>();
        expectTypeOf(params.input.transport).toEqualTypeOf<
          "external-native" | "container" | undefined
        >();
        expectTypeOf(params.input.port).toEqualTypeOf<number | undefined>();
        expectTypeOf(params.input.allowFrom).toEqualTypeOf<string[] | undefined>();
        expectTypeOf(params.input.useEnv).toEqualTypeOf<boolean | undefined>();
        expect(params).toEqual({ cfg: {}, accountId: "default", input: expected });
        return {};
      },
    },
  });
  const parsed = contract.parseInput({ ...expected, port: "8080", allowFrom: "alice,bob" });
  expect(parsed).toEqual({ ok: true, value: expected });
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  expect(
    contract.applyAccountConfig({ cfg: {}, accountId: "default", input: parsed.value }),
  ).toEqual({});
});

it.each([
  [{ transport: "managed" }, 'transport must be one of: "external-native", "container".'],
  [{ port: "8.5" }, "port must be a non-negative integer."],
] as const)("rejects invalid input %j", (input, error) => {
  const contract = defineChannelSetupContract({
    fields: { transport: fields.transport, port: fields.port },
    adapter,
  });

  expect(contract.parseInput(input)).toEqual({ ok: false, error });
});
