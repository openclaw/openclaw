import { expect, it } from "vitest";
import { runSqliteReadOperationSync } from "../infra/sqlite-schema-facts.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { selectCanonicalTailscaleProfileIdInDatabase } from "./user-profile-identity.read.js";
import { ensureProfileForTailscaleIdentity } from "./user-profiles.js";

it("resolves only the persisted canonical Tailscale profile", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const profile = ensureProfileForTailscaleIdentity({ login: "person@tailnet" });
    const { db } = openOpenClawStateDatabase();
    const read = (login: string) =>
      runSqliteReadOperationSync(db, () =>
        selectCanonicalTailscaleProfileIdInDatabase(db, login),
      );

    expect(read("person@tailnet")).toBe(profile.id);
    expect(read("other@tailnet")).toBeUndefined();
    expect(read("invalid-login")).toBeUndefined();

    db.prepare("DELETE FROM user_profile_identities WHERE provider = ? AND subject = ?").run(
      "tailnet",
      "person",
    );
    expect(read("person@tailnet")).toBeUndefined();
  });
});
