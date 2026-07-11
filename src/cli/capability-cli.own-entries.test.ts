// TTS capability — own-property safety proof
// Tests that Object.hasOwn rejects proto-chain apiKey and provider-map entries

import { describe, test, expect } from "vitest";
import {
  ttsProviderConfigHasApiKey,
  resolvedTtsConfigHasProviderApiKey,
} from "./capability-cli.ts";

describe("ttsProviderConfigHasApiKey — Object.hasOwn safety", () => {
  test("core semantic: Object.hasOwn rejects proto-inherited apiKey", () => {
    const proto = Object.create({ apiKey: "injected-key" });
    expect("apiKey" in proto).toBe(true);
    expect(Object.hasOwn(proto, "apiKey")).toBe(false);
  });

  test("proto-inherited apiKey not detected in provider config", () => {
    const configWithProto = Object.create({ apiKey: "injected-key" });
    expect(ttsProviderConfigHasApiKey(configWithProto)).toBe(false);
  });

  test("own apiKey correctly detected in provider config", () => {
    expect(ttsProviderConfigHasApiKey({ apiKey: "real-key" })).toBe(true);
  });

  test("no apiKey returns false", () => {
    expect(ttsProviderConfigHasApiKey({})).toBe(false);
  });

  test("non-object returns false", () => {
    expect(ttsProviderConfigHasApiKey(null)).toBe(false);
    expect(ttsProviderConfigHasApiKey("string")).toBe(false);
  });
});

describe("resolvedTtsConfigHasProviderApiKey — own-property safety", () => {
  const validConfig = {
    providerConfigs: {
      openai: { apiKey: "sk-real-key" },
    },
  };

  test("own provider entry with apiKey detected", () => {
    expect(resolvedTtsConfigHasProviderApiKey(validConfig, "openai")).toBe(true);
  });

  test("own provider entry without apiKey returns false", () => {
    expect(resolvedTtsConfigHasProviderApiKey({ providerConfigs: { openai: {} } }, "openai")).toBe(
      false,
    );
  });

  test("proto-inherited provider entry not detected", () => {
    // providerConfigs inherits 'openai' from prototype, not own property
    const providerConfigsWithProto = Object.create({ openai: { apiKey: "injected-key" } });
    const config = { providerConfigs: providerConfigsWithProto };
    expect(resolvedTtsConfigHasProviderApiKey(config, "openai")).toBe(false);
  });

  test("missing providerConfigs returns false", () => {
    expect(resolvedTtsConfigHasProviderApiKey({}, "openai")).toBe(false);
  });

  test("non-object config returns false", () => {
    expect(resolvedTtsConfigHasProviderApiKey(null, "openai")).toBe(false);
  });
});
