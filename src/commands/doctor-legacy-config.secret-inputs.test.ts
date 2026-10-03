// Load the shared migration mocks before their production consumers.
// oxfmt-ignore
import { legacyConfig, useDoctorLegacyConfigFixture } from "./doctor/shared/legacy-config-fixture.test-support.js";
import { describe, expect, it } from "vitest";
import { parseSecretRef } from "../config/types.secrets.js";
import { normalizeCompatibilityConfigValues } from "./doctor/shared/legacy-config-core-migrate.js";

describe("normalizeCompatibilityConfigValues", () => {
  useDoctorLegacyConfigFixture();

  it("migrates legacy secretref-env markers on SecretRef credential paths", () => {
    const res = normalizeCompatibilityConfigValues(
      legacyConfig({
        secrets: {
          defaults: {
            env: "gateway-env",
          },
        },
        channels: {
          discord: {
            token: "secretref-env:DISCORD_BOT_TOKEN",
            accounts: {
              work: {
                token: "__env__:DISCORD_WORK_TOKEN",
              },
            },
          },
        },
      }),
    );

    expect(res.config.channels?.discord?.accounts?.default).toBeUndefined();
    expect(res.config.channels?.discord?.token).toEqual({
      source: "env",
      provider: "gateway-env",
      id: "DISCORD_BOT_TOKEN",
    });
    expect(res.config.channels?.discord?.accounts?.work?.token).toEqual({
      source: "env",
      provider: "gateway-env",
      id: "DISCORD_WORK_TOKEN",
    });
    expect(res.changes).toContain(
      "Moved channels.discord.token secretref-env:DISCORD_BOT_TOKEN marker → structured env SecretRef.",
    );
    expect(res.changes).toContain(
      "Moved channels.discord.accounts.work.token __env__:DISCORD_WORK_TOKEN marker → structured env SecretRef.",
    );
  });

  it("leaves invalid legacy secretref-env markers unchanged", () => {
    const res = normalizeCompatibilityConfigValues(
      legacyConfig({
        messages: {
          groupChat: {
            visibleReplies: "message_tool",
          },
        },
        channels: {
          discord: {
            token: "secretref-env:not-valid",
          },
        },
      }),
    );

    expect(res.config.channels?.discord?.token).toBe("secretref-env:not-valid");
    expect(res.changes).toStrictEqual([]);
  });

  it.each(["env", "file", "exec", "store"] as const)(
    "adds the configured %s provider only to registered SecretRef fields",
    (source) => {
      const id = source === "file" ? "/SYNTHETIC_KEY" : "SYNTHETIC_KEY";
      const original = legacyConfig({
        secrets: { defaults: { [source]: "configured" } },
        models: {
          providers: {
            example: {
              apiKey: { source, id },
              models: [],
              baseUrl: "https://example.test/v1",
            },
            extended: {
              apiKey: { source, id, opaque: { label: "synthetic-ref-metadata" } },
              models: [],
              baseUrl: "https://example.test/v1",
            },
          },
        },
        plugins: { entries: { opaque: { config: { metadata: { source, id: "SYNTHETIC_KEY" } } } } },
      });
      const before = structuredClone(original);
      const result = normalizeCompatibilityConfigValues(original);
      expect(result.config.models?.providers?.example?.apiKey).toEqual({
        source,
        provider: "configured",
        id,
      });
      const extended = result.config.models?.providers?.extended?.apiKey;
      expect(extended).toEqual({ source, provider: "configured", id });
      expect(parseSecretRef(extended)).toBe(extended);
      expect(result.changes).toContain(
        "Canonicalized models.providers.extended.apiKey SecretRef to source/provider/id; Doctor preserves removed fields in the original config backup before writing the repair.",
      );
      expect(result.changes.join("\n")).not.toContain("synthetic-ref-metadata");
      expect(result.config.plugins?.entries?.opaque).toEqual(original.plugins?.entries?.opaque);
      expect(original).toEqual(before);
      const repeated = normalizeCompatibilityConfigValues(result.config);
      expect(repeated.config).toEqual(result.config);
      expect(repeated.changes).toEqual([]);
    },
  );
});
