import { expect, it } from "vitest";
import { runSqliteReadOperationSync } from "../infra/sqlite-schema-facts.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { selectCanonicalTailscaleProfileIdInDatabase } from "./user-profile-identity.read.js";
import { ensureProfileForTailscaleIdentity } from "./user-profiles.js";

it.each(["person@tailnet", "person@example.com"])(
  "resolves only the persisted canonical Tailscale profile for %s",
  async (login) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForTailscaleIdentity({ login });
      const { db } = openOpenClawStateDatabase();
      const read = (requestedLogin: string) =>
        runSqliteReadOperationSync(db, () =>
          selectCanonicalTailscaleProfileIdInDatabase(db, requestedLogin),
        );

      expect(read(login)).toBe(profile.id);
      expect(read(` ${login.toUpperCase()} `)).toBe(profile.id);
      expect(read("other@tailnet")).toBeUndefined();
      expect(read("invalid-login")).toBeUndefined();

      if (login === "person@tailnet") {
        db.prepare("DELETE FROM user_profile_identities WHERE provider = ? AND subject = ?").run(
          "tailnet",
          "person",
        );
      } else {
        db.prepare("DELETE FROM user_profile_emails WHERE email = ?").run(login);
      }
      expect(read(login)).toBeUndefined();
    });
  },
);
