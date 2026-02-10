import { describe, expect, test } from "vitest";
import { transformQuickBooksPayload } from "./quickbooks.js";

describe("transformQuickBooksPayload", () => {
  describe("legacy format", () => {
    test("formats a single entity notification", () => {
      const payload = {
        eventNotifications: [
          {
            realmId: "123456",
            dataChangeEvent: {
              entities: [
                {
                  id: "42",
                  name: "Invoice",
                  operation: "Create",
                  lastUpdated: "2026-02-08T10:00:00Z",
                },
              ],
            },
          },
        ],
      };

      const result = transformQuickBooksPayload(payload);
      expect(result).not.toBeNull();
      expect(result!.name).toBe("QuickBooks");
      expect(result!.message).toContain("## QuickBooks Update");
      expect(result!.message).toContain("**Company ID:** 123456");
      expect(result!.message).toContain("**Invoice** Create");
      expect(result!.message).toContain("(ID: 42)");
      expect(result!.message).toContain("2026-02-08T10:00:00Z");
      expect(result!.sessionKey).toBe("webhook:quickbooks:Invoice:42:Create");
    });

    test("formats multiple entities in one notification", () => {
      const payload = {
        eventNotifications: [
          {
            realmId: "789",
            dataChangeEvent: {
              entities: [
                {
                  id: "10",
                  name: "Invoice",
                  operation: "Create",
                  lastUpdated: "2026-02-08T10:00:00Z",
                },
                {
                  id: "20",
                  name: "Payment",
                  operation: "Create",
                  lastUpdated: "2026-02-08T10:01:00Z",
                },
              ],
            },
          },
        ],
      };

      const result = transformQuickBooksPayload(payload);
      expect(result).not.toBeNull();
      expect(result!.message).toContain("### Events");
      expect(result!.message).toContain("- **Invoice** Create");
      expect(result!.message).toContain("- **Payment** Create");
    });

    test("formats Bill entity with human-readable label", () => {
      const payload = {
        eventNotifications: [
          {
            realmId: "111",
            dataChangeEvent: {
              entities: [{ id: "5", name: "Bill", operation: "Update", lastUpdated: "" }],
            },
          },
        ],
      };

      const result = transformQuickBooksPayload(payload);
      expect(result).not.toBeNull();
      expect(result!.message).toContain("**Bill** Update");
    });

    test("handles Void and Delete operations", () => {
      const payload = {
        eventNotifications: [
          {
            realmId: "222",
            dataChangeEvent: {
              entities: [
                { id: "7", name: "Invoice", operation: "Void", lastUpdated: "" },
                { id: "8", name: "Customer", operation: "Delete", lastUpdated: "" },
              ],
            },
          },
        ],
      };

      const result = transformQuickBooksPayload(payload);
      expect(result).not.toBeNull();
      expect(result!.message).toContain("**Invoice** Void");
      expect(result!.message).toContain("**Customer** Delete");
    });

    test("handles multiple notifications with different realmIds", () => {
      const payload = {
        eventNotifications: [
          {
            realmId: "aaa",
            dataChangeEvent: {
              entities: [{ id: "1", name: "Invoice", operation: "Create", lastUpdated: "" }],
            },
          },
          {
            realmId: "bbb",
            dataChangeEvent: {
              entities: [{ id: "2", name: "Bill", operation: "Create", lastUpdated: "" }],
            },
          },
        ],
      };

      const result = transformQuickBooksPayload(payload);
      expect(result).not.toBeNull();
      // Should not show a single company ID when there are multiple
      expect(result!.message).not.toContain("**Company ID:**");
    });

    test("returns null for empty eventNotifications", () => {
      const payload = { eventNotifications: [] };
      expect(transformQuickBooksPayload(payload)).toBeNull();
    });

    test("returns null for notifications with no entities", () => {
      const payload = {
        eventNotifications: [{ realmId: "123", dataChangeEvent: { entities: [] } }],
      };
      expect(transformQuickBooksPayload(payload)).toBeNull();
    });
  });

  describe("CloudEvents format", () => {
    test("formats a single CloudEvent", () => {
      const payload = {
        specversion: "1.0",
        id: "event-uuid-1",
        source: "intuit.abc123",
        type: "qbo.invoice.created.v1",
        datacontenttype: "application/json",
        time: "2026-02-08T14:00:00Z",
        intuitentityid: "99",
        intuitaccountid: "456789",
        data: {},
      };

      const result = transformQuickBooksPayload(payload);
      expect(result).not.toBeNull();
      expect(result!.name).toBe("QuickBooks");
      expect(result!.message).toContain("## QuickBooks Update");
      expect(result!.message).toContain("**Company ID:** 456789");
      expect(result!.message).toContain("**Invoice** Created");
      expect(result!.message).toContain("(ID: 99)");
      expect(result!.sessionKey).toContain("webhook:quickbooks:");
    });

    test("formats multiple CloudEvents via events wrapper", () => {
      const payload = {
        events: [
          {
            specversion: "1.0",
            id: "e1",
            type: "qbo.bill.created.v1",
            time: "2026-02-08T15:00:00Z",
            intuitentityid: "50",
            intuitaccountid: "111",
          },
          {
            specversion: "1.0",
            id: "e2",
            type: "qbo.payment.updated.v1",
            time: "2026-02-08T15:01:00Z",
            intuitentityid: "51",
            intuitaccountid: "111",
          },
        ],
      };

      const result = transformQuickBooksPayload(payload);
      expect(result).not.toBeNull();
      expect(result!.message).toContain("### Events");
      expect(result!.message).toContain("- **Bill** Created");
      expect(result!.message).toContain("- **Payment** Updated");
    });

    test("parses CloudEvents type correctly", () => {
      const payload = {
        specversion: "1.0",
        id: "e1",
        type: "qbo.salesreceipt.voided.v1",
        time: "",
        intuitentityid: "77",
        intuitaccountid: "333",
      };

      const result = transformQuickBooksPayload(payload);
      expect(result).not.toBeNull();
      expect(result!.message).toContain("**Sales Receipt** Voided");
    });
  });

  describe("unknown payloads", () => {
    test("returns null for completely unrelated payload", () => {
      const payload = { foo: "bar", baz: 42 };
      expect(transformQuickBooksPayload(payload)).toBeNull();
    });

    test("returns null for empty object", () => {
      expect(transformQuickBooksPayload({})).toBeNull();
    });
  });
});
