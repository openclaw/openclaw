import { describe, expect, it } from "vitest";
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

describe("legacy webhook listener migration", () => {
  it.each([
    {
      name: "explicit ports and inherited bind addresses",
      input: {
        webhookPort: 8787,
        webhookHost: "0.0.0.0",
        webhookPath: "/telegram",
        accounts: {
          inherited: { botToken: "synthetic-bot" },
          port: { webhookPort: 8789 },
          host: { webhookHost: "127.0.0.2" },
        },
      },
      expected: {
        legacyWebhook: { port: 8787, host: "0.0.0.0" },
        webhookPath: "/telegram",
        accounts: {
          inherited: { botToken: "synthetic-bot" },
          port: { legacyWebhook: { port: 8789, host: "0.0.0.0" } },
          host: { legacyWebhook: { port: 8787, host: "127.0.0.2" } },
        },
      },
      changeCount: 3,
    },
    {
      name: "explicit host and default port",
      input: { webhookHost: "0.0.0.0", accounts: { other: {} } },
      expected: { legacyWebhook: { port: 8787, host: "0.0.0.0" }, accounts: { other: {} } },
      changeCount: 1,
      message: "legacyWebhook: false",
    },
    {
      name: "explicit and inherited opt-outs",
      input: {
        legacyWebhook: false,
        webhookPort: 8787,
        accounts: {
          inherited: { webhookPort: 8789, webhookHost: "0.0.0.0" },
          disabled: { legacyWebhook: false, webhookPort: 8790 },
          explicit: { legacyWebhook: { port: 9000 }, webhookPort: 8791 },
        },
      },
      expected: {
        legacyWebhook: false,
        accounts: {
          inherited: {},
          disabled: { legacyWebhook: false },
          explicit: { legacyWebhook: { port: 9000 } },
        },
      },
      changeCount: 4,
    },
    {
      name: "canonical settings and malformed ports",
      input: {
        webhookPort: 8787,
        legacyWebhook: { port: 9000 },
        accounts: { invalid: { webhookPort: "invalid" } },
      },
      expected: {
        legacyWebhook: { port: 9000 },
        accounts: { invalid: { legacyWebhook: { port: "invalid" } } },
      },
      changeCount: 2,
      message: "already configured",
    },
  ])("preserves $name", ({ input, expected, changeCount, message }) => {
    const cfg = config(structuredClone(input));
    expect(contract.legacyConfigRules[0]!.match?.(cfg.channels?.telegram, cfg)).toBe(true);
    const result = contract.normalizeCompatibilityConfig({ cfg });
    expect(result.config).toEqual(config(expected));
    expect(cfg.channels?.telegram).toEqual(input);
    expect(result.changes).toHaveLength(changeCount);
    if (message) {
      expect(result.changes[0]).toContain(message);
    }
    expect(contract.normalizeCompatibilityConfig({ cfg: result.config })).toEqual({
      config: result.config,
      changes: [],
    });
    expect(
      contract.legacyConfigRules[0]!.match?.(result.config.channels?.telegram, result.config),
    ).toBe(false);
  });

  it("leaves implicit config unchanged", () => {
    const untouched = config({ webhookUrl: "https://example.com/telegram" });
    expect(contract.normalizeCompatibilityConfig({ cfg: untouched }).config).toBe(untouched);
  });

  it.each(["0.0.0.0", undefined])("inherits canonical root port and host %s", (host) => {
    const root = { port: 9000, ...(host === undefined ? {} : { host }) };
    const result = contract.normalizeCompatibilityConfig({
      cfg: config({
        legacyWebhook: root,
        accounts: { port: { webhookPort: 9001 }, host: { webhookHost: "127.0.0.2" } },
      }),
    });
    expect(result.config).toEqual(
      config({
        legacyWebhook: root,
        accounts: {
          port: { legacyWebhook: { ...root, port: 9001 } },
          host: { legacyWebhook: { port: 9000, host: "127.0.0.2" } },
        },
      }),
    );
  });
});
