import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { expectRecordFields } from "./responses.test-support.js";

export type TalkConfigProjectionResponse = {
  config?: { talk?: Record<string, unknown>; clientHints?: Record<string, unknown> };
};

export function createTalkConfig(apiKey: unknown): OpenClawConfig {
  return {
    talk: {
      provider: "acme",
      providers: { acme: { apiKey, voiceId: "stub-default-voice" } },
    },
  } as OpenClawConfig;
}

/** Runs public wire/privacy cases inside the owning handler suite's isolated harness. */
export function defineRealtimeConfigProjectionTests(
  requestConfig: (
    config: OpenClawConfig,
    includeSecrets: boolean,
  ) => Promise<TalkConfigProjectionResponse>,
) {
  it.each([
    { includeSecrets: false, providerSelection: "explicit" },
    { includeSecrets: true, providerSelection: "explicit" },
    { includeSecrets: false, providerSelection: "implicit" },
  ] as const)(
    "projects opaque OpenAI models through the cold bundled policy surface includeSecrets=$includeSecrets provider=$providerSelection",
    async ({ includeSecrets, providerSelection }) => {
      const runtimeConfig = {
        talk: {
          realtime: {
            ...(providerSelection === "explicit" ? { provider: "openai" } : {}),
            model: "gpt-live-test-canary",
            providers: {
              openai: { model: "gpt-live-test-canary", voice: "marin" },
            },
          },
        },
      } as OpenClawConfig;
      const response = await requestConfig(runtimeConfig, includeSecrets);
      const realtime = expectRecordFields(response.config?.talk?.realtime, {
        provider: "openai",
      });
      expect(JSON.stringify(response)).not.toContain("gpt-live-test-canary");
      expect(realtime).not.toHaveProperty("model");
      const providerConfig = (realtime.providers as Record<string, unknown>).openai;
      expectRecordFields(providerConfig, { voice: "marin" });
      expect(providerConfig).not.toHaveProperty("model");
      expect(response.config?.clientHints).toEqual({
        realtime: {
          modelSource: "gateway",
          gatewayRelaySupported: false,
        },
      });
    },
  );

  it.each([false, true])(
    "preserves the released OpenAI realtime route through the cold bundled policy surface includeSecrets=%s",
    async (includeSecrets) => {
      const runtimeConfig = {
        talk: {
          realtime: {
            provider: "openai",
            model: "gpt-live-1-codex",
            providers: {
              openai: { model: "gpt-live-1-codex", voice: "spruce" },
            },
          },
        },
      } as OpenClawConfig;
      const response = await requestConfig(runtimeConfig, includeSecrets);
      const realtime = expectRecordFields(response.config?.talk?.realtime, {
        provider: "openai",
        model: "gpt-live-1-codex",
      });
      expectRecordFields((realtime.providers as Record<string, unknown>).openai, {
        model: "gpt-live-1-codex",
        voice: "spruce",
      });
      expect(response.config?.clientHints).toEqual({ realtime: { gatewayRelaySupported: true } });
    },
  );

  it.each(
    (
      JSON.parse(
        readFileSync(
          fileURLToPath(
            new URL("../../../../test/fixtures/talk-realtime-relay-contract.json", import.meta.url),
          ),
          "utf8",
        ),
      ) as { cases: Array<{ id: string; source: OpenClawConfig; config: Record<string, unknown> }> }
    ).cases,
  )("projects the Android startup wire contract: $id", async (fixture) => {
    const response = await requestConfig(fixture.source, false);
    // This same public payload drives the Android manager's socket/startup test.
    expect(response.config).toMatchObject(fixture.config);
    expect(response.config?.clientHints).toEqual(fixture.config.clientHints);
    if (fixture.id === "opaque-model") {
      expect(JSON.stringify(response)).not.toContain("gpt-live-test-canary");
    }
  });
}
