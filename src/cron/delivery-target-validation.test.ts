/** Tests delivery target validation helpers for cron jobs. */

import { describe, expect, it } from "vitest";
import { assertCronDeliveryInputNonBlankFields } from "./delivery-target-validation.js";

describe("assertCronDeliveryInputNonBlankFields", () => {
  it("accepts a valid delivery with string channel and to fields", () => {
    expect(() =>
      assertCronDeliveryInputNonBlankFields({ channel: "slack", to: "#general" }),
    ).not.toThrow();
  });

  it("rejects a non-string channel value (number)", () => {
    expect(() => assertCronDeliveryInputNonBlankFields({ channel: 123, to: "someone" })).toThrow(
      "delivery.channel must be a non-empty string",
    );
  });

  it("rejects a non-string channel value (boolean)", () => {
    expect(() => assertCronDeliveryInputNonBlankFields({ channel: true, to: "someone" })).toThrow(
      "delivery.channel must be a non-empty string",
    );
  });

  it("rejects a non-string to value (object)", () => {
    expect(() => assertCronDeliveryInputNonBlankFields({ channel: "slack", to: {} })).toThrow(
      "delivery.to must be a non-empty string",
    );
  });

  it("rejects a blank string channel value", () => {
    expect(() => assertCronDeliveryInputNonBlankFields({ channel: "   ", to: "someone" })).toThrow(
      "delivery.channel must be a non-empty string",
    );
  });

  it("rejects a blank string to value", () => {
    expect(() => assertCronDeliveryInputNonBlankFields({ channel: "slack", to: "" })).toThrow(
      "delivery.to must be a non-empty string",
    );
  });

  it("rejects a non-string failureDestination.channel value", () => {
    expect(() =>
      assertCronDeliveryInputNonBlankFields({
        channel: "slack",
        to: "someone",
        failureDestination: { channel: 456, to: "admin" },
      }),
    ).toThrow("delivery.failureDestination.channel must be a non-empty string");
  });

  it("accepts a valid failureDestination with string fields", () => {
    expect(() =>
      assertCronDeliveryInputNonBlankFields({
        channel: "slack",
        to: "someone",
        failureDestination: { channel: "email", to: "admin@example.com" },
      }),
    ).not.toThrow();
  });

  it("accepts a valid completionDestination with string to field", () => {
    expect(() =>
      assertCronDeliveryInputNonBlankFields({
        channel: "slack",
        to: "someone",
        completionDestination: { to: "done" },
      }),
    ).not.toThrow();
  });

  it("rejects a non-string completionDestination.to value", () => {
    expect(() =>
      assertCronDeliveryInputNonBlankFields({
        channel: "slack",
        to: "someone",
        completionDestination: { to: 789 },
      }),
    ).toThrow("delivery.completionDestination.to must be a non-empty string");
  });

  it("does not throw when delivery is undefined or null", () => {
    expect(() => assertCronDeliveryInputNonBlankFields(undefined)).not.toThrow();
    expect(() => assertCronDeliveryInputNonBlankFields(null)).not.toThrow();
  });
});
