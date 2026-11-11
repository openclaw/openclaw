import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { SignalAccountConfig } from "../../../config/types.signal.js";
import { maybeRepairAllowlistPolicyAllowFrom } from "./allowlist-policy-repair.js";

const { readChannelAllowFromStoreMock } = vi.hoisted(() => ({
  readChannelAllowFromStoreMock: vi.fn(),
}));

vi.mock("../../../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: readChannelAllowFromStoreMock,
}));

// Mirror declared capabilities without loading bundled plugins for every repair.
vi.mock("../channel-capabilities.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channel-capabilities.js")>();
  return {
    ...actual,
    getDoctorChannelCapabilities: (channelName?: string) => ({
      dmAllowFromMode: channelName === "matrix" ? "nestedOnly" : "topOnly",
      groupModel: "sender",
      groupAllowFromFallbackToAllowFrom: true,
      warnOnEmptyGroupSenderAllowlist: true,
    }),
  };
});

describe("doctor allowlist-policy repair", () => {
  beforeEach(() => {
    readChannelAllowFromStoreMock.mockReset();
  });

  it.each([
    ["inherited policy", [], {}, true],
    ["inherited allowlist", ["root-sender"], { dmPolicy: "allowlist" }, false],
    ["explicit empty allowlist", ["root-sender"], { allowFrom: [] }, true],
    ["explicit pairing override", [], { dmPolicy: "pairing" }, false],
  ] satisfies Array<[string, string[], SignalAccountConfig, boolean]>)(
    "resolves %s before recovering account senders",
    async (_name, rootAllowFrom, account, recovered) => {
      readChannelAllowFromStoreMock.mockImplementation(
        async (_channel: string, _env: NodeJS.ProcessEnv, accountId: string) =>
          accountId === "work" ? ["account-sender"] : [],
      );
      const cfg: OpenClawConfig = {
        channels: {
          signal: {
            dmPolicy: "allowlist",
            allowFrom: rootAllowFrom,
            accounts: { work: account },
          },
        },
      };

      const result = await maybeRepairAllowlistPolicyAllowFrom(cfg);

      expect(result.config.channels?.signal).toEqual({
        dmPolicy: "allowlist",
        allowFrom: rootAllowFrom,
        accounts: { work: recovered ? { ...account, allowFrom: ["account-sender"] } : account },
      });
      expect(result.changes).toEqual(
        recovered
          ? [
              '- channels.signal.accounts.work.allowFrom: restored 1 sender entry from pairing store (dmPolicy="allowlist").',
            ]
          : [],
      );
    },
  );

  it("restores matrix dm allowFrom from the pairing store into the nested path", async () => {
    readChannelAllowFromStoreMock.mockResolvedValue(["@alice:example.org"]);

    const result = await maybeRepairAllowlistPolicyAllowFrom({
      channels: {
        matrix: { dm: { policy: "allowlist" } },
      },
    });

    expect(result.changes).toEqual([
      '- channels.matrix.dm.allowFrom: restored 1 sender entry from pairing store (dmPolicy="allowlist").',
    ]);
    expect(result.config.channels?.matrix?.allowFrom).toBeUndefined();
    expect(result.config.channels?.matrix?.dm?.allowFrom).toEqual(["@alice:example.org"]);
  });

  it("skips disabled channel and account entries", async () => {
    readChannelAllowFromStoreMock.mockResolvedValue(["alice"]);

    const cfg: OpenClawConfig = {
      channels: {
        telegram: { enabled: false, dmPolicy: "allowlist" },
        signal: { accounts: { disabled: { enabled: false, dmPolicy: "allowlist" } } },
      },
    };

    const expected = { config: structuredClone(cfg), changes: [] };
    expect(await maybeRepairAllowlistPolicyAllowFrom(cfg)).toEqual(expected);
    expect(readChannelAllowFromStoreMock).not.toHaveBeenCalled();
  });
});
