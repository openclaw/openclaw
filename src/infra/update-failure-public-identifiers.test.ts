import { expect, it } from "vitest";
import {
  SKIPPED_UPDATE_OUTCOMES,
  UPDATE_ENVIRONMENT_FAILURE_REASONS,
} from "../shared/update-outcome.js";
import {
  preparePublicUpdateFailureIdentifiers,
  projectPublicUpdateFailureIdentifiers,
} from "./update-failure-public-identifiers.js";

// Load the real catalogs before individual assertion deadlines, as the reporter does.
await preparePublicUpdateFailureIdentifiers();

it.each([...Object.keys(SKIPPED_UPDATE_OUTCOMES), ...UPDATE_ENVIRONMENT_FAILURE_REASONS])(
  "preserves the public update outcome %s in report identifiers",
  async (reason) => {
    const fact = { check: reason, code: reason };
    await expect(projectPublicUpdateFailureIdentifiers(fact)).resolves.toEqual(fact);
  },
);

it("keeps unknown check and reason identifiers private", async () => {
  await expect(
    projectPublicUpdateFailureIdentifiers({ check: "private-check", code: "private-reason" }),
  ).resolves.toEqual({ check: "[redacted-check]", code: "[redacted-code]" });
});

it("publishes only the fixed lease code, not the internal class or arbitrary identities", async () => {
  await expect(
    projectPublicUpdateFailureIdentifiers({ check: "doctor", code: "agent-database-lease-active" }),
  ).resolves.toEqual({ check: "doctor", code: "agent-database-lease-active" });
  for (const code of [
    "OpenClawAgentDatabaseLeaseActiveError",
    "private-lease-class",
    "/private/state.db",
    "token=fixture-only-token",
    "alice@example.invalid",
  ]) {
    await expect(
      projectPublicUpdateFailureIdentifiers({ check: "doctor", code, errorName: code }),
    ).resolves.toEqual({ check: "doctor", code: "[redacted-error-class]" });
  }
});
