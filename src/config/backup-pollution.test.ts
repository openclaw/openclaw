import { describe, expect, it } from "vitest";
import { findRedactedSecretSites } from "./backup-pollution.js";

describe("findRedactedSecretSites", () => {
  it("returns empty array for clean configs", () => {
    expect(
      findRedactedSecretSites({
        gateway: { mode: "local", auth: { token: "real-secret-token-value" } },
        plugins: { entries: { brave: { config: { webSearch: { apiKey: "BSAreal-key-1234" } } } } },
      }),
    ).toEqual([]);
  });

  it("flags asterisk-redacted apiKey at any depth", () => {
    expect(
      findRedactedSecretSites({
        plugins: {
          entries: {
            brave: { config: { webSearch: { apiKey: "***" } } },
          },
        },
      }),
    ).toEqual(["plugins.entries.brave.config.webSearch.apiKey"]);
  });

  it("flags ASCII ellipsis-style maskApiKey output", () => {
    expect(
      findRedactedSecretSites({
        models: { providers: { bailian: { apiKey: "sk-12345...5678abcd" } } },
      }),
    ).toEqual(["models.providers.bailian.apiKey"]);
  });

  it("flags unicode ellipsis variants", () => {
    expect(
      findRedactedSecretSites({
        gateway: { auth: { token: "tok-abc\u2026xyz-99" } },
      }),
    ).toEqual(["gateway.auth.token"]);
  });

  it("collects every polluted site under one config", () => {
    expect(
      findRedactedSecretSites({
        gateway: { auth: { token: "***" } },
        models: { providers: { openai: { apiKey: "sk-12...ab" } } },
      }).toSorted(),
    ).toEqual(["gateway.auth.token", "models.providers.openai.apiKey"]);
  });

  it("ignores asterisks in non-secret keys", () => {
    expect(
      findRedactedSecretSites({
        ui: { greeting: "***", placeholder: "***" },
      }),
    ).toEqual([]);
  });

  it("ignores long high-entropy real secrets that contain dots", () => {
    expect(
      findRedactedSecretSites({
        plugins: {
          entries: {
            x: { config: { apiKey: "sk-proj-9c2.4f8.7a1.b3e.0d2.6c5.9a8.1f4.afterFully" } },
          },
        },
      }),
    ).toEqual([]);
  });

  it("walks arrays without crashing", () => {
    expect(
      findRedactedSecretSites({
        list: [{ token: "***" }, { token: "real-token" }],
      }),
    ).toEqual(["list.0.token"]);
  });
});
