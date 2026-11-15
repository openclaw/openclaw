import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { expectRecordFields } from "./responses.test-support.js";

export type TalkConfigProjectionResponse = {
  config?: { talk?: Record<string, unknown>; clientHints?: Record<string, unknown> };
};

export function createTalkConfig(apiKey: unknown): OpenClawConfig {
  const acme = { apiKey, voiceId: "stub-default-voice" };
  return { talk: { provider: "acme", providers: { acme } } } as OpenClawConfig;
}

/** Runs public wire/privacy cases inside the owning handler suite's isolated harness. */
export function defineRealtimeConfigProjectionTests(
  requestConfig: (
    config: OpenClawConfig,
    includeSecrets: boolean,
  ) => Promise<TalkConfigProjectionResponse>,
) {
  it.each([
    ["opaque", false, true],
    ["opaque", true, true],
    ["opaque", false, false],
    ["released", false, true],
    ["released", true, true],
  ] as const)(
    "projects %s OpenAI models through the cold bundled policy (secrets=%s explicit=%s)",
    async (route, includeSecrets, explicit) => {
      const released = route === "released";
      const model = released ? "gpt-live-1-codex" : "gpt-live-test-canary";
      const voice = released ? "spruce" : "marin";
      const response = await requestConfig(
        {
          talk: {
            realtime: {
              ...(explicit ? { provider: "openai" } : {}),
              model,
              providers: { openai: { model, voice } },
            },
          },
        },
        includeSecrets,
      );
      const realtime = expectRecordFields(response.config?.talk?.realtime, {
        provider: "openai",
        ...(released ? { model } : {}),
      });
      const providerConfig = (realtime.providers as Record<string, unknown>).openai;
      expectRecordFields(providerConfig, { voice, ...(released ? { model } : {}) });
      if (!released) {
        expect(JSON.stringify(response)).not.toContain(model);
        expect(realtime).not.toHaveProperty("model");
        expect(providerConfig).not.toHaveProperty("model");
      }
      expect(response.config?.clientHints).toEqual({
        realtime: {
          ...(!released ? { modelSource: "gateway" } : {}),
          gatewayRelaySupported: released,
        },
      });
    },
  );

  const fixturePath = new URL(
    "../../../../test/fixtures/talk-realtime-relay-contract.json",
    import.meta.url,
  );
  const fixtures = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    cases: Array<{ id: string; source: OpenClawConfig; config: Record<string, unknown> }>;
  };
  it.each(fixtures.cases)("projects the Android startup wire contract: $id", async (fixture) => {
    const response = await requestConfig(fixture.source, false);
    // This same public payload drives the Android manager's socket/startup test.
    expect(response.config).toMatchObject(fixture.config);
    expect(response.config?.clientHints).toEqual(fixture.config.clientHints);
    if (fixture.id === "opaque-model") {
      expect(JSON.stringify(response)).not.toContain("gpt-live-test-canary");
    }
  });
}
