import { describe, expect, test } from "vitest";
import { transformOwnerRezPayload } from "./ownerrez.js";

describe("transformOwnerRezPayload", () => {
  test("formats a booking insert with embedded entity", () => {
    const payload = {
      id: "wh-1",
      user_id: 12345,
      action: "entity_insert",
      entity_type: "booking",
      entity_id: "bk-100",
      categories: ["reservation"],
      entity: {
        arrival: "2026-03-15",
        departure: "2026-03-20",
        adults: 2,
        children: 1,
        status: "confirmed",
        guest_name: "Alice Smith",
        property_name: "Lakeside Cabin",
        total_amount: "1250.00",
        currency: "USD",
        source: "Airbnb",
        booked_utc: "2026-02-08T14:30:00Z",
      },
    };

    const result = transformOwnerRezPayload(payload);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("OwnerRez");
    expect(result!.message).toContain("## OwnerRez: Booking Created");
    expect(result!.message).toContain("**Booking ID:** bk-100");
    expect(result!.message).toContain("**Guest:** Alice Smith");
    expect(result!.message).toContain("**Property:** Lakeside Cabin");
    expect(result!.message).toContain("**Dates:** 2026-03-15 to 2026-03-20");
    expect(result!.message).toContain("**Guests:** 2 adults, 1 child");
    expect(result!.message).toContain("**Status:** confirmed");
    expect(result!.message).toContain("**Total:** 1250.00 USD");
    expect(result!.message).toContain("**Source:** Airbnb");
    expect(result!.sessionKey).toBe("webhook:ownerrez:booking:bk-100");
  });

  test("formats a booking update without entity details", () => {
    const payload = {
      id: "wh-2",
      user_id: 12345,
      action: "entity_update",
      entity_type: "booking",
      entity_id: "bk-200",
      categories: ["cancellation"],
    };

    const result = transformOwnerRezPayload(payload);
    expect(result).not.toBeNull();
    expect(result!.message).toContain("## OwnerRez: Booking Updated");
    expect(result!.message).toContain("**Categories:** cancellation");
  });

  test("formats a booking delete", () => {
    const payload = {
      id: "wh-3",
      action: "entity_delete",
      entity_type: "booking",
      entity_id: "bk-300",
    };

    const result = transformOwnerRezPayload(payload);
    expect(result).not.toBeNull();
    expect(result!.message).toContain("## OwnerRez: Booking Deleted");
  });

  test("formats a contact insert with embedded entity", () => {
    const payload = {
      id: "wh-4",
      action: "entity_insert",
      entity_type: "contact",
      entity_id: "ct-50",
      entity: {
        first_name: "Bob",
        last_name: "Jones",
        email: "bob@example.com",
        phone: "+15551234567",
      },
    };

    const result = transformOwnerRezPayload(payload);
    expect(result).not.toBeNull();
    expect(result!.message).toContain("## OwnerRez: Contact Created");
    expect(result!.message).toContain("**Name:** Bob Jones");
    expect(result!.message).toContain("**Email:** bob@example.com");
    expect(result!.message).toContain("**Phone:** +15551234567");
    expect(result!.sessionKey).toBe("webhook:ownerrez:contact:ct-50");
  });

  test("handles authorization revoked", () => {
    const payload = {
      action: "application_authorization_revoked",
      user_id: 999,
    };

    const result = transformOwnerRezPayload(payload);
    expect(result).not.toBeNull();
    expect(result!.message).toContain("authorization has been revoked");
    expect(result!.sessionKey).toContain("auth-revoked");
  });

  test("handles property entity type", () => {
    const payload = {
      id: "wh-5",
      action: "entity_update",
      entity_type: "property",
      entity_id: "prop-10",
    };

    const result = transformOwnerRezPayload(payload);
    expect(result).not.toBeNull();
    expect(result!.message).toContain("## OwnerRez: Property Updated");
  });

  test("returns null for empty payload", () => {
    expect(transformOwnerRezPayload({})).toBeNull();
  });

  test("returns null for unknown action", () => {
    const payload = { action: "some_random_action" };
    expect(transformOwnerRezPayload(payload)).toBeNull();
  });

  test("returns null when entity_type is missing", () => {
    const payload = { action: "entity_insert" };
    expect(transformOwnerRezPayload(payload)).toBeNull();
  });

  test("handles multiple children correctly in guest count", () => {
    const payload = {
      id: "wh-6",
      action: "entity_insert",
      entity_type: "booking",
      entity_id: "bk-400",
      entity: {
        adults: 1,
        children: 3,
      },
    };

    const result = transformOwnerRezPayload(payload);
    expect(result).not.toBeNull();
    expect(result!.message).toContain("1 adult");
    expect(result!.message).toContain("3 children");
  });
});
