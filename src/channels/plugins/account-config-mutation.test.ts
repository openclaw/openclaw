import { assert, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import { createNonExitingRuntimeEnv } from "../../test-utils/plugin-runtime-env.js";
import {
  applyPreparedChannelAccountConfiguration,
  prepareChannelAccountConfiguration,
} from "./account-config-mutation.js";
import { defineChannelSetupContract } from "./setup-contract.js";
import type { ChannelPlugin } from "./types.plugin.js";

const { log, error, exit } = createNonExitingRuntimeEnv();
const runtime = { log, error, exit };

function prepare(
  plugin: ChannelPlugin,
  input: unknown,
  overrides: Partial<Parameters<typeof prepareChannelAccountConfiguration>[0]> = {},
) {
  return prepareChannelAccountConfiguration({
    cfg: {},
    plugin,
    resolveInput: () => input,
    runtime,
    ...overrides,
  });
}

it("prepares, validates, applies, and reports lifecycle changes in order", async () => {
  const callOrder: string[] = [];
  const beforePersistentEffect = vi.fn(async () => {
    callOrder.push("authority");
  });
  const cfg = { channels: { "test-chat": { token: "old-token" } } } satisfies OpenClawConfig;
  const plugin = {
    ...createChannelTestPluginBase({ id: "test-chat" }),
    setup: {
      singleAccountKeysToMove: ["token"],
      prepareAccountConfigInput: ({ input }: { input: Record<string, unknown> }) => {
        callOrder.push("prepare");
        return { ...input, token: "prepared-token" };
      },
      validateInput: ({ input }: { input: Record<string, unknown> }) => {
        callOrder.push("validate");
        return input.token === "prepared-token" ? null : "input was not prepared";
      },
      applyAccountConfig: ({ cfg: inputCfg, accountId, input }) => {
        callOrder.push("apply");
        const accounts: Record<string, { token: string }> =
          inputCfg.channels?.["test-chat"]?.accounts ?? {};
        return {
          channels: {
            "test-chat": {
              accounts: {
                ...accounts,
                [accountId]: { token: (input as { token: string }).token },
              },
            },
          },
        };
      },
    },
    lifecycle: {
      onAccountConfigChanged: ({ prevCfg, nextCfg, accountId }) => {
        callOrder.push("lifecycle");
        expect(prevCfg).toBe(cfg);
        expect(accountId).toBe("work");
        expect(nextCfg.channels?.["test-chat"]).toMatchObject({
          accounts: {
            default: { token: "old-token" },
            work: { token: "prepared-token" },
          },
        });
      },
    },
  } as ChannelPlugin;

  const options = { cfg, requestedAccountId: "Work", beforePersistentEffect };
  const prepared = await prepare(plugin, { token: "raw-token" }, options);
  assert(prepared.ok, "expected prepared account configuration");

  const applied = await applyPreparedChannelAccountConfiguration({
    cfg,
    channel: "test-chat",
    prepared: prepared.value,
    runtime,
    beforePersistentEffect,
  });

  expect(callOrder).toEqual([
    "authority",
    "prepare",
    "validate",
    "apply",
    "authority",
    "lifecycle",
  ]);
  expect(applied.accountId).toBe("work");
  expect(applied.input).toEqual({ token: "prepared-token" });
});

it.each([
  ["rejects unknown options before mutation", "token", "string", { unknownOption: true }, false],
  ["accepts use-env without env metadata", "useEnv", "boolean", { useEnv: true }, true],
] as const)("setup contract %s", async (_name, key, kind, input, ok) => {
  const applyAccountConfig = vi.fn(({ cfg }) => cfg);
  const plugin = {
    ...createChannelTestPluginBase({ id: "typed-chat" }),
    setupContract: defineChannelSetupContract({
      fields: {
        [key]: {
          kind,
          cli: { flags: key === "token" ? "--token <token>" : "--use-env", description: key },
        },
      },
      adapter: { applyAccountConfig },
    }),
  } as ChannelPlugin;

  const prepared = await prepare(plugin, input);
  expect(prepared.ok).toBe(ok);
  if (!ok) {
    expect(prepared).toEqual({
      ok: false,
      error: { kind: "invalid-input", message: "Unsupported setup option: unknownOption" },
    });
    expect(applyAccountConfig).not.toHaveBeenCalled();
  }
});

it("does not resolve input when the channel has no account setup capability", async () => {
  const resolveInput = vi.fn(() => {
    throw new Error("input should stay lazy");
  });
  const plugin = createChannelTestPluginBase({ id: "read-only-chat" }) as ChannelPlugin;

  const prepared = await prepare(plugin, undefined, { resolveInput });

  expect(prepared).toEqual({ ok: false, error: { kind: "unsupported" } });
  expect(resolveInput).not.toHaveBeenCalled();
});
