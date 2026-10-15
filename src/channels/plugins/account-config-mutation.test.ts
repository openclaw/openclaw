import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import {
  applyPreparedChannelAccountConfiguration,
  prepareChannelAccountConfiguration,
} from "./account-config-mutation.js";
import { defineChannelSetupContract } from "./setup-contract.js";
import type { ChannelPlugin } from "./types.plugin.js";

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
} as never;

describe("channel account config mutations", () => {
  it("prepares, validates, applies, and reports lifecycle changes in order", async () => {
    const callOrder: string[] = [];
    const beforePersistentEffect = vi.fn(async () => {
      callOrder.push("authority");
    });
    const cfg = {
      channels: {
        "test-chat": {
          enabled: true,
          token: "old-token",
        },
      },
    } satisfies OpenClawConfig;
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
          const channel = inputCfg.channels?.["test-chat"] as
            | {
                enabled?: boolean;
                accounts?: Record<string, Record<string, unknown>>;
              }
            | undefined;
          return {
            ...inputCfg,
            channels: {
              ...inputCfg.channels,
              "test-chat": {
                ...channel,
                accounts: {
                  ...channel?.accounts,
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

    const prepared = await prepareChannelAccountConfiguration({
      cfg,
      plugin,
      requestedAccountId: "Work",
      resolveInput: () => ({ token: "raw-token" }),
      runtime,
      beforePersistentEffect,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      return;
    }

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

  it("returns channel-owned setup parse errors before config mutation", async () => {
    const applyAccountConfig = vi.fn(({ cfg }) => cfg);
    const plugin = {
      ...createChannelTestPluginBase({ id: "typed-chat" }),
      setupContract: defineChannelSetupContract({
        fields: {
          token: {
            kind: "string",
            cli: { flags: "--token <token>", description: "Bot token" },
          },
        },
        adapter: { applyAccountConfig },
      }),
    } as ChannelPlugin;

    const prepared = await prepareChannelAccountConfiguration({
      cfg: {},
      plugin,
      resolveInput: () => ({ unknownOption: true }),
      runtime,
    });

    expect(prepared).toEqual({
      ok: false,
      error: {
        kind: "invalid-input",
        message: "Unsupported setup option: unknownOption",
      },
    });
    expect(applyAccountConfig).not.toHaveBeenCalled();
  });

  it("preserves --use-env behavior for contracts without env metadata", async () => {
    const applyAccountConfig = vi.fn(({ cfg }) => cfg);
    const plugin = {
      ...createChannelTestPluginBase({ id: "third-party-chat" }),
      setupContract: defineChannelSetupContract({
        fields: {
          useEnv: {
            kind: "boolean",
            cli: { flags: "--use-env", description: "Use plugin environment credentials" },
          },
        },
        adapter: { applyAccountConfig },
      }),
    } as ChannelPlugin;

    const prepared = await prepareChannelAccountConfiguration({
      cfg: {},
      plugin,
      resolveInput: () => ({ useEnv: true }),
      runtime,
    });

    expect(prepared.ok).toBe(true);
  });

  it("does not resolve input when the channel has no account setup capability", async () => {
    const resolveInput = vi.fn(() => {
      throw new Error("input should stay lazy");
    });
    const plugin = createChannelTestPluginBase({ id: "read-only-chat" }) as ChannelPlugin;

    const prepared = await prepareChannelAccountConfiguration({
      cfg: {},
      plugin,
      resolveInput,
      runtime,
    });

    expect(prepared).toEqual({
      ok: false,
      error: { kind: "unsupported" },
    });
    expect(resolveInput).not.toHaveBeenCalled();
  });
});
