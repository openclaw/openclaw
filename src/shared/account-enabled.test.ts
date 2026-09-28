import { describe, expect, it } from "vitest";
import { isAccountEnabled } from "./account-enabled.js";

describe("isAccountEnabled", () => {
  it.each([
    [{ enabled: true }, true],
    [{ enabled: false }, false],
    [{}, true],
    [null, true],
    ["account-name", true],
  ])("resolves %j to %s", (account, expected) => {
    expect(isAccountEnabled(account)).toBe(expected);
  });
});
