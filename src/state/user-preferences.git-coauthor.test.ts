import { describe, expect, it } from "vitest";
import { prepareUserPreferenceUpdate } from "./user-preferences.validation.js";

describe("Git co-author preference writes", () => {
  it.each([
    { name: "Alice", email: "" },
    { name: "", email: "alice@example.test" },
    { name: "Alice\nCo-authored-by: Other", email: "alice@example.test" },
    { name: "Alice\u2028Other", email: "alice@example.test" },
    { name: "Alice\u2029Other", email: "alice@example.test" },
    { name: "Alice <Other>", email: "alice@example.test" },
    { name: "Alice", email: "alice@example.test\nOther" },
    { name: "Alice", email: "Alice <alice@example.test>" },
  ])("rejects an incomplete or injectable credit pair %j", (value) => {
    expect(prepareUserPreferenceUpdate({ "git.coauthor.identity": value })).toEqual({
      ok: false,
      error: { code: "invalid-value", key: "git.coauthor.identity" },
    });
  });

  it("normalizes a complete pair and allows clearing the override", () => {
    expect(
      prepareUserPreferenceUpdate({
        "git.coauthor.identity": { name: " Alice Example ", email: " alice@example.test " },
      }),
    ).toMatchObject({
      ok: true,
      value: {
        serialized: [
          {
            prefKey: "git.coauthor.identity",
            valueJson: '{"name":"Alice Example","email":"alice@example.test"}',
          },
        ],
      },
    });
    expect(prepareUserPreferenceUpdate({ "git.coauthor.identity": null })).toMatchObject({
      ok: true,
      value: { deletionKeys: ["git.coauthor.identity"] },
    });
  });

  it.each([null, { name: "Forged Organization", email: "forged@example.test" }])(
    "refuses a public preference write to the organization default: %j",
    (value) => {
      expect(prepareUserPreferenceUpdate({ "git.coauthor.organization": value })).toEqual({
        ok: false,
        error: { code: "invalid-key", key: "git.coauthor.organization" },
      });
    },
  );
});
