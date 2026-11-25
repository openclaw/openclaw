import { describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  getCanonicalUserPreferences,
  setCanonicalUserPreferences,
} from "../../state/user-preferences.js";
import { ensureGatewayOwnerProfile } from "../../state/user-profiles.js";
import { withEngineStoreAdmission as admit } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

describe.skipIf(!mixedAgentConnection).each(["sqlite", "postgres"] as const)(
  "%s domain commit receipts",
  (engine) => {
    useMixedAgentPair(engine, "sqlite");

    it("acknowledges ordinary preference writes and reads them back after reopening", async () => {
      const { profile, databasePath } = admit(() => ({
        profile: ensureGatewayOwnerProfile("Receipt conformance operator"),
        databasePath: openOpenClawStateDatabase().path,
      }));
      const entries = { "notifications.enabled": true };
      const outcome = await setCanonicalUserPreferences(profile.id, entries).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await closeOpenClawStateDatabaseByPathAsync(databasePath);
      const persisted = await getCanonicalUserPreferences(profile.id);
      expect({ outcome, persisted }).toEqual({
        outcome: { value: { ok: true, value: { profileId: profile.id } } },
        persisted: { profileId: profile.id, entries },
      });
    });
  },
);
