import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createLegacyWebhookListenerDoctorContract } from "./legacy-webhook-listener-migration.js";

const contract = createLegacyWebhookListenerDoctorContract({
  channelKey: "telegram",
  defaultPort: 8787,
  defaultHost: "127.0.0.1",
});
const config = (entry: Record<string, unknown>): OpenClawConfig => ({
  channels: { telegram: entry },
});
const legacy = (port: number | string, host?: string) => ({
  legacyWebhook: { port, ...(host === undefined ? {} : { host }) },
});
const inherited = { botToken: "synthetic-bot" };
const withAccounts = (root: Record<string, unknown>, accounts: Record<string, unknown>) => ({
  ...root,
  accounts,
});

it.each([
  [
    "explicit ports and inherited bind addresses",
    withAccounts(
      { webhookPort: 8787, webhookHost: "0.0.0.0", webhookPath: "/telegram" },
      { inherited, port: { webhookPort: 8789 }, host: { webhookHost: "127.0.0.2" } },
    ),
    withAccounts(
      { ...legacy(8787, "0.0.0.0"), webhookPath: "/telegram" },
      { inherited, port: legacy(8789, "0.0.0.0"), host: legacy(8787, "127.0.0.2") },
    ),
    3,
    undefined,
  ],
  [
    "explicit host and default port",
    { webhookHost: "0.0.0.0", accounts: { other: {} } },
    { ...legacy(8787, "0.0.0.0"), accounts: { other: {} } },
    1,
    "legacyWebhook: false",
  ],
  [
    "explicit and inherited opt-outs",
    withAccounts(
      { legacyWebhook: false, webhookPort: 8787 },
      {
        inherited: { webhookPort: 8789, webhookHost: "0.0.0.0" },
        disabled: { legacyWebhook: false, webhookPort: 8790 },
        explicit: { ...legacy(9000), webhookPort: 8791 },
      },
    ),
    withAccounts(
      { legacyWebhook: false },
      {
        inherited: {},
        disabled: { legacyWebhook: false },
        explicit: legacy(9000),
      },
    ),
    4,
    undefined,
  ],
  [
    "canonical settings and malformed ports",
    { webhookPort: 8787, ...legacy(9000), accounts: { invalid: { webhookPort: "invalid" } } },
    { ...legacy(9000), accounts: { invalid: legacy("invalid") } },
    2,
    "already configured",
  ],
  ...["0.0.0.0", undefined].map(
    (host) =>
      [
        `canonical root port and host ${host}`,
        withAccounts(legacy(9000, host), {
          port: { webhookPort: 9001 },
          host: { webhookHost: "127.0.0.2" },
        }),
        withAccounts(legacy(9000, host), {
          port: legacy(9001, host),
          host: legacy(9000, "127.0.0.2"),
        }),
        2,
        undefined,
      ] as const,
  ),
] as const)("preserves %s", (_name, input, expected, changeCount, message) => {
  const cfg = config(structuredClone(input));
  const match = (value: OpenClawConfig) =>
    contract.legacyConfigRules[0]!.match?.(value.channels?.telegram, value);
  expect(match(cfg)).toBe(true);
  const result = contract.normalizeCompatibilityConfig({ cfg });
  expect(result.config).toEqual(config(expected));
  expect(cfg.channels?.telegram).toEqual(input);
  expect(result.changes).toHaveLength(changeCount);
  if (message) {
    expect(result.changes[0]).toContain(message);
  }
  const unchanged = contract.normalizeCompatibilityConfig({ cfg: result.config });
  expect(unchanged.config).toBe(result.config);
  expect(unchanged.changes).toEqual([]);
  expect(match(result.config)).toBe(false);
});

it("leaves implicit config unchanged", () => {
  const untouched = config({ webhookUrl: "https://example.com/telegram" });
  expect(contract.normalizeCompatibilityConfig({ cfg: untouched }).config).toBe(untouched);
});
