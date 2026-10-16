import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import type { AuthProfileCredential, UserModelAuthProfile } from "../agents/auth-profiles/types.js";
import { isSqliteLockError } from "../infra/sqlite-error-diagnostics.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import {
  clearUserProfileAuthLink,
  connectUserModelAccount,
  setUserProfileAuthLink,
  updateUserModelAuthProfile,
} from "./user-model-accounts.js";
import { ensureProfileForEmail } from "./user-profiles.js";

const credential: AuthProfileCredential = {
  type: "token",
  provider: "synthetic",
  token: "synthetic-contention-token",
};

/** String-stage entry points keep their loose stage callback. */
type Admit = (stage: "transaction" | "commit") => void;
/** updateUserModelAuthProfile revalidates through the structured admission callback. */
type StructuredAdmit = (
  operation: { stage: "transaction" } | { stage: "commit"; profile: UserModelAuthProfile },
) => void;

const stageOf = (admission: string | { stage: "transaction" | "commit" }) =>
  typeof admission === "string" ? admission : admission.stage;

it.each([
  [
    "credential update",
    (admit: StructuredAdmit, _owner: string, profileId: string) =>
      updateUserModelAuthProfile(profileId, () => true, {}, admit),
  ],
  [
    "account connect",
    (admit: Admit, owner: string, _profileId: string) =>
      connectUserModelAccount({ ownerProfileId: owner, credential, assertCurrent: admit }),
  ],
  [
    "link selection",
    (admit: Admit, owner: string, _profileId: string) =>
      setUserProfileAuthLink({
        profileId: owner,
        provider: credential.provider,
        authProfileId: "synthetic:contention",
        assertCurrent: admit,
      }),
  ],
  [
    "unlink selection",
    (admit: Admit, owner: string, _profileId: string) =>
      clearUserProfileAuthLink({
        profileId: owner,
        provider: credential.provider,
        assertCurrent: admit,
      }),
  ],
] as const)("leaves the writer free while the host decides %s admission", async (_name, write) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const profile = ensureProfileForEmail("contention@example.test");
    const connected = connectUserModelAccount({
      ownerProfileId: profile.id,
      credential,
      assertCurrent() {},
    });
    const competitor = new DatabaseSync(resolveOpenClawStateSqlitePath());
    competitor.exec("PRAGMA busy_timeout = 0");
    const observed: string[] = [];
    try {
      write(
        (admission) => {
          try {
            competitor.exec("BEGIN IMMEDIATE");
            competitor.exec("ROLLBACK");
            observed.push(`${stageOf(admission)}:free`);
          } catch (error) {
            if (!isSqliteLockError(error)) {
              throw error;
            }
            observed.push(`${stageOf(admission)}:held`);
          }
        },
        profile.id,
        connected.authProfileId,
      );
    } finally {
      competitor.close();
    }
    expect(observed).toEqual(["transaction:free", "commit:held"]);
  });
});
