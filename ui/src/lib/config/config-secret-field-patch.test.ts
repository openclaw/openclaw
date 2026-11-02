import { describe, expect, it } from "vitest";
import { buildSecretFieldPatch } from "./config-secret-field-patch.ts";

describe("buildSecretFieldPatch", () => {
  const base = {
    gateway: { auth: { mode: "token", password: "__OPENCLAW_REDACTED__" } },
    logging: { level: "info" },
  };

  it("carries the field and nothing else from the saved config", () => {
    expect(
      buildSecretFieldPatch({
        base,
        draft: { ...base, logging: { level: "debug" } },
        path: ["gateway", "auth", "token"],
        value: "abc",
      }),
    ).toEqual({ patch: { gateway: { auth: { token: "abc" } } }, replacePaths: [] });
  });

  it("removes the field with a merge-patch null", () => {
    expect(
      buildSecretFieldPatch({
        base,
        draft: base,
        path: ["gateway", "auth", "password"],
        value: undefined,
      }).patch,
    ).toEqual({ gateway: { auth: { password: null } } });
  });

  it("creates missing parents when the draft has nothing either", () => {
    expect(
      buildSecretFieldPatch({ base, draft: base, path: ["talk", "voice", "apiKey"], value: "abc" })
        .patch,
    ).toEqual({ talk: { voice: { apiKey: "abc" } } });
  });

  it("sends a new entry whole, so a required secret can complete it", () => {
    expect(
      buildSecretFieldPatch({
        base,
        draft: { ...base, models: { providers: { local: { baseUrl: "http://x", models: [] } } } },
        path: ["models", "providers", "local", "apiKey"],
        value: "abc",
      }).patch,
    ).toEqual({
      models: { providers: { local: { baseUrl: "http://x", models: [], apiKey: "abc" } } },
    });
  });

  it("replaces a saved array, keeping its other entries as saved", () => {
    expect(
      buildSecretFieldPatch({
        base: { hooks: { rules: [{ token: "__OPENCLAW_REDACTED__" }, { token: "" }] } },
        draft: { hooks: { rules: [{ token: "__OPENCLAW_REDACTED__" }, { token: "" }, {}] } },
        path: ["hooks", "rules", 1, "token"],
        value: "abc",
      }),
    ).toEqual({
      patch: { hooks: { rules: [{ token: "__OPENCLAW_REDACTED__" }, { token: "abc" }] } },
      replacePaths: ["hooks.rules"],
    });
  });

  it("takes a row the saved array doesn't hold yet from the draft", () => {
    expect(
      buildSecretFieldPatch({
        base: { hooks: { rules: [{ token: "__OPENCLAW_REDACTED__" }] } },
        draft: { hooks: { rules: [{ token: "__OPENCLAW_REDACTED__" }, { name: "new" }] } },
        path: ["hooks", "rules", 1, "token"],
        value: "abc",
      }).patch,
    ).toEqual({
      hooks: { rules: [{ token: "__OPENCLAW_REDACTED__" }, { name: "new", token: "abc" }] },
    });
  });
});
