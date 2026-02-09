import { describe, expect, test } from "vitest";
import { transformShopifyPayload } from "./shopify.js";

describe("transformShopifyPayload", () => {
  describe("orders", () => {
    test("formats a new order", () => {
      const payload = {
        id: 12345,
        order_number: 1042,
        email: "alice@example.com",
        financial_status: "paid",
        fulfillment_status: null,
        total_price: "89.99",
        currency: "USD",
        created_at: "2026-02-08T10:00:00Z",
        note: "Please gift wrap",
        customer: {
          first_name: "Alice",
          last_name: "Smith",
        },
        line_items: [
          { title: "Widget Pro", quantity: 2, price: "29.99" },
          { title: "Accessory Pack", quantity: 1, price: "30.01" },
        ],
        shipping_address: {
          city: "Portland",
          province: "Oregon",
          country: "US",
        },
      };

      const result = transformShopifyPayload(payload);
      expect(result).not.toBeNull();
      expect(result!.name).toBe("Shopify");
      expect(result!.message).toContain("## Shopify Order Paid");
      expect(result!.message).toContain("**Order:** #1042");
      expect(result!.message).toContain("**Customer:** Alice Smith (alice@example.com)");
      expect(result!.message).toContain("**Total:** 89.99 USD");
      expect(result!.message).toContain("**Payment:** paid");
      expect(result!.message).toContain("**Ship to:** Portland, Oregon, US");
      expect(result!.message).toContain("### Items");
      expect(result!.message).toContain("- Widget Pro x2 ($29.99)");
      expect(result!.message).toContain("- Accessory Pack ($30.01)");
      expect(result!.message).toContain("**Note:** Please gift wrap");
      expect(result!.sessionKey).toBe("webhook:shopify:order:12345");
    });

    test("formats a fulfilled order", () => {
      const payload = {
        id: 999,
        order_number: 1050,
        financial_status: "paid",
        fulfillment_status: "fulfilled",
        total_price: "50.00",
        line_items: [],
      };

      const result = transformShopifyPayload(payload);
      expect(result).not.toBeNull();
      expect(result!.message).toContain("## Shopify Order Fulfilled");
    });

    test("formats a cancelled order", () => {
      const payload = {
        id: 888,
        order_number: 1060,
        financial_status: "refunded",
        fulfillment_status: "unfulfilled",
        cancelled_at: "2026-02-08T12:00:00Z",
        total_price: "25.00",
        line_items: [],
      };

      const result = transformShopifyPayload(payload);
      expect(result).not.toBeNull();
      expect(result!.message).toContain("## Shopify Order Cancelled");
    });

    test("handles order with only email, no customer object", () => {
      const payload = {
        id: 777,
        order_number: 1070,
        email: "solo@example.com",
        financial_status: "paid",
        total_price: "10.00",
        line_items: [],
      };

      const result = transformShopifyPayload(payload);
      expect(result).not.toBeNull();
      expect(result!.message).toContain("**Customer:** solo@example.com");
    });
  });

  describe("customers", () => {
    test("formats a customer event", () => {
      const payload = {
        id: 5001,
        first_name: "Bob",
        last_name: "Jones",
        email: "bob@example.com",
        phone: "+15559876543",
        orders_count: 12,
        total_spent: "450.00",
        tags: "vip, wholesale",
        created_at: "2024-06-15T08:00:00Z",
      };

      const result = transformShopifyPayload(payload);
      expect(result).not.toBeNull();
      expect(result!.message).toContain("## Shopify Customer Update");
      expect(result!.message).toContain("**Name:** Bob Jones");
      expect(result!.message).toContain("**Email:** bob@example.com");
      expect(result!.message).toContain("**Orders:** 12");
      expect(result!.message).toContain("**Total spent:** $450.00");
      expect(result!.message).toContain("**Tags:** vip, wholesale");
      expect(result!.sessionKey).toBe("webhook:shopify:customer:5001");
    });
  });

  describe("products", () => {
    test("formats a product event", () => {
      const payload = {
        id: 3001,
        title: "Super Widget",
        product_type: "Gadgets",
        vendor: "WidgetCo",
        status: "active",
        variants: [{ id: 1 }, { id: 2 }, { id: 3 }],
      };

      const result = transformShopifyPayload(payload);
      expect(result).not.toBeNull();
      expect(result!.message).toContain("## Shopify Product Update");
      expect(result!.message).toContain("**Product:** Super Widget");
      expect(result!.message).toContain("**Type:** Gadgets");
      expect(result!.message).toContain("**Vendor:** WidgetCo");
      expect(result!.message).toContain("**Variants:** 3");
      expect(result!.sessionKey).toBe("webhook:shopify:product:3001");
    });
  });

  describe("refunds", () => {
    test("formats a refund event", () => {
      const payload = {
        id: 8001,
        order_id: 12345,
        created_at: "2026-02-08T15:00:00Z",
        note: "Customer changed mind",
        refund_line_items: [{ id: 1 }, { id: 2 }],
      };

      const result = transformShopifyPayload(payload);
      expect(result).not.toBeNull();
      expect(result!.message).toContain("## Shopify Refund");
      expect(result!.message).toContain("**Order ID:** 12345");
      expect(result!.message).toContain("**Reason:** Customer changed mind");
      expect(result!.message).toContain("**Items refunded:** 2");
      expect(result!.sessionKey).toBe("webhook:shopify:refund:8001");
    });
  });

  describe("generic and edge cases", () => {
    test("formats unknown entity with id as generic", () => {
      const payload = {
        id: 9999,
        status: "active",
        name: "Something",
      };

      const result = transformShopifyPayload(payload);
      expect(result).not.toBeNull();
      expect(result!.message).toContain("## Shopify Event");
      expect(result!.message).toContain("**Entity ID:** 9999");
    });

    test("returns null for empty payload", () => {
      expect(transformShopifyPayload({})).toBeNull();
    });

    test("returns null for payload without id or recognizable shape", () => {
      const payload = { foo: "bar", baz: 42 };
      expect(transformShopifyPayload(payload)).toBeNull();
    });
  });
});
