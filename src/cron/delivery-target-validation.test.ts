// Delivery target validation tests cover cron input field blank-check guards.
import { describe, expect, it } from "vitest";
import { assertCronDeliveryInputNonBlankFields } from "./delivery-target-validation.js";

describe("assertCronDeliveryInputNonBlankFields", () => {
  it("does not throw for null, undefined, or non-object delivery", () => {
    expect(() => assertCronDeliveryInputNonBlankFields(null)).not.toThrow();
    expect(() => assertCronDeliveryInputNonBlankFields(undefined)).not.toThrow();
    expect(() => assertCronDeliveryInputNonBlankFields("string")).not.toThrow();
  });

  it("throws when completionDestination to is blank", () => {
    expect(() =>
      assertCronDeliveryInputNonBlankFields({
        channel: "slack",
        to: "#general",
        completionDestination: { to: "   " },
      }),
    ).toThrow("delivery.completionDestination.to must be a non-empty string");
  });

  it("does not throw when nested destinations have valid fields", () => {
    expect(() =>
      assertCronDeliveryInputNonBlankFields({
        channel: "slack",
        to: "#general",
        failureDestination: { channel: "email", to: "admin@example.com" },
        completionDestination: { to: "done" },
      }),
    ).not.toThrow();
  });
});
