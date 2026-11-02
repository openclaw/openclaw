import { describe, expect, it } from "vitest";
import { isSecretConfigField } from "./config-form.secret-field.tsx";

describe("isSecretConfigField", () => {
  it("follows the schema's marking, not the field name", () => {
    expect(isSecretConfigField(["a", "code"], { "a.code": { sensitive: true } })).toBe(true);
    expect(isSecretConfigField(["a", "apiKey"], {})).toBe(false);
    expect(isSecretConfigField(["a", "apiKey"], { "a.apiKey": { sensitive: false } })).toBe(false);
  });

  it("resolves map and array entries through their wildcard marking", () => {
    const hints = { "env.*": { sensitive: true }, "hooks.rules.*.token": { sensitive: true } };
    expect(isSecretConfigField(["env", "ANYTHING"], hints)).toBe(true);
    expect(isSecretConfigField(["hooks", "rules", 2, "token"], hints)).toBe(true);
    expect(
      isSecretConfigField(["tools", "models", 1, "auth", "token"], {
        "tools.models[].auth.token": { sensitive: true },
      }),
    ).toBe(true);
  });

  it("inherits from a marked parent unless a nearer hint says otherwise", () => {
    const hints = { oauth: { sensitive: true }, "oauth.clientId": { sensitive: false } };
    expect(isSecretConfigField(["oauth", "clientSecret"], hints)).toBe(true);
    expect(isSecretConfigField(["oauth", "clientId"], hints)).toBe(false);
  });
});
