import { expect, it } from "vitest";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import {
  buildAccountScopedDmSecurityPolicy,
  formatPairingApproveHint,
  parseOptionalDelimitedEntries,
  resolveChannelDefaultAccountId,
} from "./helpers.js";

it.each([
  ["unlisted", ["supplied"], ["listed"], "unlisted"],
  ["", undefined, ["listed"], ""],
  [undefined, ["supplied", "second"], ["listed"], "supplied"],
  [undefined, [], ["listed"], "default"],
  [undefined, undefined, ["listed", "second"], "listed"],
  [undefined, undefined, [], "default"],
  [undefined, undefined, ["", "second"], ""],
] satisfies [string | undefined, string[] | undefined, string[], string][])(
  "resolves default=%j supplied=%j listed=%j to %j",
  (defaultId, accountIds, listed, result) => {
    const plugin = createChannelTestPluginBase({ id: "accountchat" });
    plugin.config.listAccountIds = () => listed;
    plugin.config.defaultAccountId = defaultId === undefined ? undefined : () => defaultId;
    expect(resolveChannelDefaultAccountId({ plugin, cfg: {}, accountIds })).toBe(result);
  },
);

type PolicyInput = Omit<
  Parameters<typeof buildAccountScopedDmSecurityPolicy>[0],
  "cfg" | "channelKey"
>;
const allowlist = { policy: "allowlist", allowFrom: ["+15550001111"] } satisfies PolicyInput;
const pairing = { policy: "pairing", allowFrom: ["*"] } satisfies PolicyInput;
const accounts = { default: { dmPolicy: "allowlist", allowFrom: ["+15550001111"] }, work: {} };
function expected(policy: string, allowFrom: string[], scope = "", suffix = "") {
  return {
    policy,
    allowFrom,
    policyPath: suffix ? undefined : `channels.demo.${scope}dmPolicy`,
    allowFromPath: `channels.demo.${scope}${suffix}`,
    approveHint: formatPairingApproveHint("demo"),
    normalizeEntry: undefined,
  };
}
it.each([
  ["root", pairing, {}, expected("pairing", ["*"])],
  [
    "account",
    { ...allowlist, accountId: "work" },
    { accounts: { work: {} } },
    expected("allowlist", ["+15550001111"], "accounts.work."),
  ],
  [
    "nested",
    { ...pairing, accountId: "work", allowFromPathSuffix: "dm.", policyPathSuffix: undefined },
    { accounts: { work: {} } },
    expected("pairing", ["*"], "accounts.work.", "dm."),
  ],
  [
    "inherited",
    { ...allowlist, accountId: "work", inheritSharedDefaultsFromDefaultAccount: true },
    { accounts },
    expected("allowlist", ["+15550001111"], "accounts.default."),
  ],
  [
    "no inheritance",
    { ...pairing, accountId: "work" },
    { allowFrom: ["*"], dmPolicy: "pairing", accounts },
    expected("pairing", ["*"]),
  ],
  [
    "custom defaults",
    { allowFrom: ["user-1"], defaultPolicy: "allowlist", approveHint: "custom" },
    {},
    { ...expected("allowlist", ["user-1"]), approveHint: "custom" },
  ],
] satisfies [string, PolicyInput, Record<string, unknown>, ReturnType<typeof expected>][])(
  "builds %s security policy paths",
  (_name, overrides, section, result) => {
    expect(
      buildAccountScopedDmSecurityPolicy({
        channelKey: "demo",
        cfg: { channels: { demo: section } },
        fallbackAccountId: "default",
        policyPathSuffix: "dmPolicy",
        ...overrides,
      }),
    ).toEqual(result);
  },
);

it.each([
  ["  ", undefined],
  ["alpha, beta\ngamma; delta", ["alpha", "beta", "gamma", "delta"]],
] as const)("parses optional entries %j", (input, result) => {
  expect(parseOptionalDelimitedEntries(input)).toEqual(result);
});
