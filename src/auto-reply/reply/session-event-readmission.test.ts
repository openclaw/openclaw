import { expect, it } from "vitest";
import {
  SessionDeliveryGenerationRevokedError,
  SessionDeliveryGenerationUnavailableError,
} from "../../config/sessions/session-delivery-generation-errors.js";
import { createSessionEventReadmission } from "./session-event-readmission.js";

const unchanged = { changed: false };

it("retries only an attempt that ended on an unavailable lease", async () => {
  // Stop and queue cleanup abandon without an error: terminal.
  expect(createSessionEventReadmission(unchanged, 0).rejects(undefined)).toBe(false);
  expect(
    createSessionEventReadmission(unchanged, 0).rejects(
      "Session event was abandoned before execution",
    ),
  ).toBe(false);

  // Latched source authority carries the refusal as its cause.
  const wrapped = createSessionEventReadmission(unchanged, 0);
  expect(
    wrapped.rejects(
      new Error("source execution authority is no longer active", {
        cause: new SessionDeliveryGenerationUnavailableError(),
      }),
    ),
  ).toBe(true);

  // A rejected adoption leaves no error for abandonment, so adopt() records its cause.
  const adoption = createSessionEventReadmission(unchanged, 0);
  const refusal = new SessionDeliveryGenerationUnavailableError();
  await expect(
    adoption.adopt(async () => {
      throw refusal;
    }),
  ).rejects.toBe(refusal);
  expect(adoption.rejects(undefined)).toBe(true);

  // A replaced session never comes back, whatever was noted before or after.
  const revoked = createSessionEventReadmission(unchanged, 0);
  expect(revoked.rejects(new SessionDeliveryGenerationRevokedError())).toBe(false);
  expect(revoked.rejects(new SessionDeliveryGenerationUnavailableError())).toBe(false);

  expect(createSessionEventReadmission({ changed: true }, 0).rejects()).toBe(true);
});
