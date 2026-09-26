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
  it("preserves explicit ports and inherited bind addresses without changing unrelated settings", () => {
    const cfg = config({
      webhookPort: 8787,
      webhookHost: "0.0.0.0",
      webhookPath: "/telegram",
      accounts: {
        inherited: { botToken: "synthetic-bot" },
        port: { webhookPort: 8789 },
        host: { webhookHost: "127.0.0.2" },
      },
    });
    expect(contract.legacyConfigRules[0]!.match?.(cfg.channels?.telegram, cfg)).toBe(true);
    const result = contract.normalizeCompatibilityConfig({ cfg });
    expect(result.config).toEqual(
      config({
        legacyWebhook: { port: 8787, host: "0.0.0.0" },
        webhookPath: "/telegram",
        accounts: {
          inherited: { botToken: "synthetic-bot" },
          port: { legacyWebhook: { port: 8789, host: "0.0.0.0" } },
          host: { legacyWebhook: { port: 8787, host: "127.0.0.2" } },
        },
      }),
    );
    expect(cfg.channels?.telegram).toHaveProperty("webhookPort", 8787);
    expect(result.changes).toHaveLength(3);
    expect(contract.normalizeCompatibilityConfig({ cfg: result.config })).toEqual({
      config: result.config,
      changes: [],
    });
    expect(
      contract.legacyConfigRules[0]!.match?.(result.config.channels?.telegram, result.config),
    ).toBe(false);
  });

  it("preserves an explicit bind host with the old default port and leaves implicit config unchanged", () => {
    const result = contract.normalizeCompatibilityConfig({
      cfg: config({ webhookHost: "0.0.0.0", accounts: { other: {} } }),
    });
    expect(result.config).toEqual(
      config({ legacyWebhook: { port: 8787, host: "0.0.0.0" }, accounts: { other: {} } }),
    );
    expect(result.changes).toEqual([expect.stringContaining("legacyWebhook: false")]);
    const untouched = config({ webhookUrl: "https://example.com/telegram" });
    expect(contract.normalizeCompatibilityConfig({ cfg: untouched }).config).toBe(untouched);
  });

  it("preserves explicit and inherited opt-outs while removing retired listener keys", () => {
    const result = contract.normalizeCompatibilityConfig({
      cfg: config({
        legacyWebhook: false,
        webhookPort: 8787,
        accounts: {
          inherited: { webhookPort: 8789, webhookHost: "0.0.0.0" },
          disabled: { legacyWebhook: false, webhookPort: 8790 },
          explicit: { legacyWebhook: { port: 9000 }, webhookPort: 8791 },
        },
      }),
    });
    expect(result.config).toEqual(
      config({
        legacyWebhook: false,
        accounts: {
          inherited: {},
          disabled: { legacyWebhook: false },
          explicit: { legacyWebhook: { port: 9000 } },
        },
      }),
    );
    expect(contract.normalizeCompatibilityConfig({ cfg: result.config })).toEqual({
      config: result.config,
      changes: [],
    });
  });

  it.each(["0.0.0.0", undefined])(
    "inherits canonical root port and host %s when accounts still use retired keys",
    (host) => {
      const root = { port: 9000, ...(host === undefined ? {} : { host }) };
      const result = contract.normalizeCompatibilityConfig({
        cfg: config({
          legacyWebhook: root,
          accounts: {
            port: { webhookPort: 9001 },
            host: { webhookHost: "127.0.0.2" },
          },
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
    },
  );

  it("keeps canonical settings authoritative and malformed ports visible to validation", () => {
    const result = contract.normalizeCompatibilityConfig({
      cfg: config({
        webhookPort: 8787,
        legacyWebhook: { port: 9000 },
        accounts: { invalid: { webhookPort: "invalid" } },
      }),
    });
    expect(result.config).toEqual(
      config({
        legacyWebhook: { port: 9000 },
        accounts: { invalid: { legacyWebhook: { port: "invalid" } } },
      }),
    );
    expect(result.changes[0]).toContain("already configured");
  });
});
