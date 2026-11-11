import { describe, expect, it } from "vitest";
import { prepareUserPreferenceUpdate } from "./user-preferences.validation.js";

describe("Git co-author preference writes", () => {
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
