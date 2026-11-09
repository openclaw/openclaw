import { describe, expect, it, vi } from "vitest";
import { isSecretConfigField } from "../lib/config-form-utils.ts";
import { recordCompositionEnd } from "../lib/ime.ts";
import { handleHeldSecretKey, type SecretFieldHold } from "./config-form.secret-field.tsx";

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

describe("handleHeldSecretKey", () => {
  const hold = {
    text: () => "held-value",
    saving: () => false,
  } as unknown as SecretFieldHold;
  const options = {
    multiline: false,
    onSave: vi.fn(),
    onCancel: vi.fn(),
  };
  const keydown = (init: KeyboardEventInit = {}) =>
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...init });

  it("does not save a one-line held edit while an IME composition is active", () => {
    expect(handleHeldSecretKey(keydown({ isComposing: true }), hold, options)).toBe(false);
    expect(options.onSave).not.toHaveBeenCalled();
  });

  it("does not save when the Enter carries the native IME keyCode 229", () => {
    expect(handleHeldSecretKey(keydown({ keyCode: 229 }), hold, options)).toBe(false);
    expect(options.onSave).not.toHaveBeenCalled();
  });

  it("still saves a held edit on an ordinary Enter", () => {
    expect(handleHeldSecretKey(keydown(), hold, options)).toBe(true);
    expect(options.onSave).toHaveBeenCalledOnce();
  });

  it("does not save the flagless commit Enter right after compositionend (WebKit grace)", () => {
    options.onSave.mockClear();
    const target = document.createElement("input");
    const composed = new CompositionEvent("compositionend", { bubbles: true });
    Object.defineProperty(composed, "target", { value: target });
    recordCompositionEnd(composed);
    const commitEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      isComposing: false,
      keyCode: 13,
    });
    Object.defineProperty(commitEnter, "target", { value: target });
    expect(handleHeldSecretKey(commitEnter, hold, options)).toBe(false);
    expect(options.onSave).not.toHaveBeenCalled();
  });
});
