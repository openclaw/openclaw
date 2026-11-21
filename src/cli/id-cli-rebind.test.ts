import { describe, expect, it } from "vitest";
import { describeKeysState } from "./id-cli.js";

describe("openclaw id status", () => {
  it("explains refused keys with the fix", () => {
    expect(describeKeysState({ state: "keys_refused", reason: "keys_missing" })).toContain(
      "openclaw id rebind",
    );
    expect(describeKeysState({ state: "keys_refused", reason: "key_mismatch" })).toContain(
      "Restore the original key file",
    );
    expect(describeKeysState({ state: "on" })).toBe("Remote access: on");
  });
});
