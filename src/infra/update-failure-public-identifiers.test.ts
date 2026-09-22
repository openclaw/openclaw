import { expect, it } from "vitest";
import { SKIPPED_UPDATE_OUTCOMES } from "../shared/update-outcome.js";
import { projectPublicUpdateFailureIdentifiers } from "./update-failure-public-identifiers.js";

it.each(Object.keys(SKIPPED_UPDATE_OUTCOMES))(
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
