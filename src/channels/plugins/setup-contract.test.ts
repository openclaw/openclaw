import { describe, expect, it, vi } from "vitest";
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

describe("defineChannelSetupContract", () => {
  it("keeps released adapters intact while preferring channel-owned contracts", () => {
    const setup = adapter;
    const setupContract = defineChannelSetupContract({ fields: {}, adapter: setup });

    expect(resolveChannelSetupExecutionAdapter({ setup })).toBe(setup);
    expect(resolveChannelSetupExecutionAdapter({ setup, setupContract })).toBe(setupContract);
    expect(resolveChannelSetupExecutionAdapter({})).toBeUndefined();
  });

  it("keeps ignored aliases ineligible during cold channel-owned promotion", () => {
    const defaultAccount = "work-phone";
    const next = withPluginCache(createPluginCache(), () => {
      const plugin = {
        setupContract: defineChannelSetupContract({
          fields: {},
          adapter: {
            accountKeyPolicy: { canonicalAliasesRequireOwnField: "account" },
            singleAccountKeysToMove: ["account"],
            namedAccountPromotionKeys: ["account"],
            applyAccountConfig: ({ cfg }) => cfg,
          },
        }),
      };
      const cfg: OpenClawConfig = {
        channels: {
          demo: {
            account: "+12025550123",
            defaultAccount,
            accounts: {
              "Work Phone": { dmPolicy: "open", allowFrom: ["*"] },
            },
          },
        },
      };

      return moveSingleAccountChannelSectionToDefaultAccount({
        cfg,
        channelKey: "demo",
        setupSurface: resolveChannelSetupExecutionAdapter(plugin),
      });
    });

    expect(next.channels?.demo).toEqual({
      defaultAccount,
      accounts: {
        "Work Phone": { dmPolicy: "open", allowFrom: ["*"] },
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
    const applyAccountConfig = vi.fn(
      ({
        input,
      }: {
        input: {
          name?: string;
          token?: string;
          transport?: "external-native" | "container";
          port?: number;
          allowFrom?: string[];
          useEnv?: boolean;
        };
      }) => {
        void input.token;
        return {};
      },
    );
    const contract = defineChannelSetupContract({ fields, adapter: { applyAccountConfig } });
    const expected = {
      name: "work",
      token: "secret",
      transport: "container",
      port: 8080,
      allowFrom: ["alice", "bob"],
      useEnv: true,
    };
    const parsed = contract.parseInput({ ...expected, port: "8080", allowFrom: "alice,bob" });
    expect(parsed).toEqual({ ok: true, value: expected });
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    expect(
      contract.applyAccountConfig({ cfg: {}, accountId: "default", input: parsed.value }),
    ).toEqual({});
    expect(applyAccountConfig).toHaveBeenCalledWith({
      cfg: {},
      accountId: "default",
      input: expected,
    });
  });

  it.each([
    [{ token: "wrong channel" }, "Unsupported setup option: token"],
    [{ transport: "managed" }, 'transport must be one of: "external-native", "container".'],
    [{ port: "8.5" }, "port must be a non-negative integer."],
  ] as const)("rejects invalid input %j", (input, error) => {
    const contract = defineChannelSetupContract({
      fields: { transport: fields.transport, port: fields.port },
      adapter,
    });

    expect(contract.parseInput(input)).toEqual({ ok: false, error });
  });
});
