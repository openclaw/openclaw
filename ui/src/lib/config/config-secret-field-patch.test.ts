import { describe, expect, it } from "vitest";
import { buildSecretFieldPatch, secretRowMatchesSavedList } from "./config-secret-field-patch.ts";

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

describe("secretRowMatchesSavedList", () => {
  const R = "__OPENCLAW_REDACTED__";
  const base = {
    hooks: {
      rules: [
        { name: "a", token: R },
        { name: "b", token: R },
      ],
    },
  };
  const at = (rules: unknown[], row: number) =>
    secretRowMatchesSavedList({
      base,
      draft: { hooks: { rules } },
      path: ["hooks", "rules", row, "token"],
    });

  it("matches while the draft's list is the saved one, or only adds rows", () => {
    expect(at(base.hooks.rules, 1)).toBe(true);
    expect(at([...base.hooks.rules, { name: "c" }], 2)).toBe(true);
    expect(at([...base.hooks.rules, { name: "c" }], 1)).toBe(true);
    expect(
      secretRowMatchesSavedList({ base, draft: null, path: ["hooks", "rules", 0, "token"] }),
    ).toBe(true);
    expect(
      secretRowMatchesSavedList({ base, draft: base, path: ["gateway", "auth", "token"] }),
    ).toBe(true);
  });

  it("refuses when unsaved rows moved, vanished or changed", () => {
    const [a, b] = base.hooks.rules;
    expect(
      secretRowMatchesSavedList({
        base,
        draft: { hooks: {} },
        path: ["hooks", "rules", 0, "token"],
      }),
    ).toBe(false);
    expect(at([b], 0)).toBe(false);
    expect(at([b, a], 0)).toBe(false);
    expect(at([{ name: "new" }, a, b], 1)).toBe(false);
    expect(at([{ ...a, name: "renamed" }, b], 1)).toBe(false);
  });
});
