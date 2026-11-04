// Load-time validation for cron default destinations: channel existence and agent keys.
import { describe, expect, it } from "vitest";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import { listCronDefaultDestinationChannels } from "./cron-default-destinations.js";
import type { CronConfig } from "./types.cron.js";
import { validateConfigObject, validateConfigObjectWithPlugins } from "./validation.js";
import { OpenClawSchema } from "./zod-schema.js";

const unknownChannel = (channel: string) =>
  `unknown channel id: ${channel} (install its channel plugin or correct this setting)`;

function validateCron(cron: CronConfig) {
  return validateConfigObjectWithPlugins(
    { agents: { entries: { openclaw: {} } }, cron, plugins: { enabled: false } },
    {
      pluginMetadataSnapshot: {
        manifestRegistry: {
          diagnostics: [],
          plugins: [
            createPluginManifestRecordFixture({
              id: "chat-plugin",
              channels: ["chat"],
              origin: "config",
            }),
          ],
        },
      },
    },
  );
}

describe("cron default destination channels", () => {
  it("lists every explicit default channel and skips last and webhook routes", () => {
    expect(
      listCronDefaultDestinationChannels({
        delivery: { channel: " chat ", to: "1" },
        failureAlert: { channel: "Last", to: "1" },
        agents: {
          ops: {
            delivery: { to: "1" },
            failureAlert: { mode: "webhook", channel: "ignored", to: "https://example.invalid" },
          },
        },
        creators: { alice: { failureAlert: { channel: "ghost", to: "1" } } },
      }),
    ).toEqual([
      { path: "cron.delivery.channel", channel: "chat", globalFailureAlert: false },
      {
        path: "cron.creators.alice.failureAlert.channel",
        channel: "ghost",
        globalFailureAlert: false,
      },
    ]);
  });

  it("accepts defaults on known channels, including built-in aliases", () => {
    const result = validateCron({
      delivery: { channel: "chat", to: "1" },
      agents: { ops: { delivery: { channel: "telegram", to: "-100123" } } },
      creators: { alice: { failureAlert: { channel: "gchat", to: "spaces/a" } } },
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.filter(({ path }) => path.startsWith("cron."))).toEqual([]);
  });

  it.each<[string, CronConfig]>([
    ["cron.delivery.channel", { delivery: { channel: "telegarm", to: "1" } }],
    [
      "cron.agents.ops.delivery.channel",
      { agents: { ops: { delivery: { channel: "telegarm", to: "1" } } } },
    ],
    [
      "cron.agents.ops.failureAlert.channel",
      { agents: { ops: { failureAlert: { channel: "telegarm", to: "1" } } } },
    ],
    [
      "cron.creators.alice.delivery.channel",
      { creators: { alice: { delivery: { channel: "telegarm", to: "1" } } } },
    ],
    [
      "cron.creators.alice.failureAlert.channel",
      { creators: { alice: { failureAlert: { channel: "telegarm", to: "1" } } } },
    ],
  ])("rejects an unknown channel at %s", (path, cron) => {
    const result = validateCron(cron);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({ path, message: unknownChannel("telegarm") });
    }
  });

  it("only warns for an unknown cron.failureAlert channel so existing configs still load", () => {
    const result = validateCron({ failureAlert: { channel: "telegarm", to: "1" } });
    expect(result.ok).toBe(true);
    expect(result.warnings.filter(({ path }) => path.startsWith("cron."))).toEqual([
      { path: "cron.failureAlert.channel", message: unknownChannel("telegarm") },
    ]);
  });
});

describe("cron.agents keys", () => {
  it("rejects keys that resolve to the same agent id", () => {
    const result = OpenClawSchema.safeParse({
      cron: {
        agents: {
          Ops: { delivery: { channel: "telegram", to: "1" } },
          ops: { delivery: { channel: "slack", to: "channel:C1" } },
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["cron", "agents", "ops"],
          message:
            'cron.agents keys "Ops" and "ops" resolve to the same agent id "ops"; rename one key so each agent has a unique id',
        }),
      );
    }
  });

  it("accepts distinct agent keys in any case", () => {
    expect(
      validateConfigObject({
        cron: {
          agents: {
            Ops: { delivery: { channel: "telegram", to: "1" } },
            main: { delivery: { channel: "telegram", to: "2" } },
          },
        },
      }).ok,
    ).toBe(true);
  });
});
