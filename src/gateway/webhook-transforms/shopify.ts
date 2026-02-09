export type ShopifyTransformResult = {
  message: string;
  name: string;
  sessionKey: string;
} | null;

/**
 * Transforms a Shopify webhook payload into an agent message.
 *
 * Shopify sends the topic in the X-Shopify-Topic header, but since we receive
 * just the JSON body, we infer the event type from the payload shape.
 *
 * Common topics: orders/create, orders/updated, orders/paid, orders/cancelled,
 * orders/fulfilled, customers/create, customers/update, products/create,
 * products/update, refunds/create, etc.
 *
 * The payload contains full entity details (order, customer, product, etc.).
 */
export function transformShopifyPayload(payload: Record<string, unknown>): ShopifyTransformResult {
  // Detect payload type by presence of distinctive fields
  if (isOrderPayload(payload)) {
    return formatOrder(payload);
  }
  if (isCustomerPayload(payload)) {
    return formatCustomer(payload);
  }
  if (isProductPayload(payload)) {
    return formatProduct(payload);
  }
  if (isRefundPayload(payload)) {
    return formatRefund(payload);
  }

  // Generic fallback for any Shopify payload with an id
  if (payload.id !== undefined) {
    return formatGeneric(payload);
  }

  return null;
}

// -- Order --

function isOrderPayload(payload: Record<string, unknown>): boolean {
  return (
    payload.order_number !== undefined ||
    (payload.financial_status !== undefined && payload.line_items !== undefined)
  );
}

function formatOrder(payload: Record<string, unknown>): ShopifyTransformResult {
  const orderId = toStr(payload.id);
  const orderNumber = toStr(payload.order_number ?? payload.number);
  const email = stringField(payload, "email");
  const financialStatus = stringField(payload, "financial_status");
  const fulfillmentStatus = stringField(payload, "fulfillment_status") || "unfulfilled";
  const totalPrice = stringField(payload, "total_price");
  const currency = stringField(payload, "currency");
  const createdAt = stringField(payload, "created_at");
  const cancelledAt = stringField(payload, "cancelled_at");
  const note = stringField(payload, "note");

  const customer = payload.customer as Record<string, unknown> | undefined;
  const customerName = customer
    ? [stringField(customer, "first_name"), stringField(customer, "last_name")]
        .filter(Boolean)
        .join(" ")
    : "";

  const lineItems = Array.isArray(payload.line_items) ? payload.line_items : [];
  const shippingAddress = payload.shipping_address as Record<string, unknown> | undefined;

  const isCancelled = Boolean(cancelledAt);
  const action = isCancelled ? "Cancelled" : inferOrderAction(financialStatus, fulfillmentStatus);

  const lines: string[] = [];
  lines.push(`## Shopify Order ${action}`);
  lines.push("");

  if (orderNumber) {
    lines.push(`**Order:** #${orderNumber}`);
  }
  if (customerName || email) {
    lines.push(
      `**Customer:** ${customerName || email}${customerName && email ? ` (${email})` : ""}`,
    );
  }
  if (totalPrice) {
    lines.push(`**Total:** ${totalPrice}${currency ? ` ${currency}` : ""}`);
  }
  if (financialStatus) {
    lines.push(`**Payment:** ${financialStatus}`);
  }
  if (fulfillmentStatus) {
    lines.push(`**Fulfillment:** ${fulfillmentStatus}`);
  }
  if (createdAt) {
    lines.push(`**Date:** ${createdAt}`);
  }

  if (shippingAddress) {
    const city = stringField(shippingAddress, "city");
    const province = stringField(shippingAddress, "province");
    const country = stringField(shippingAddress, "country");
    const location = [city, province, country].filter(Boolean).join(", ");
    if (location) {
      lines.push(`**Ship to:** ${location}`);
    }
  }

  if (lineItems.length > 0) {
    lines.push("");
    lines.push("### Items");
    lines.push("");
    for (const item of lineItems) {
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const rec = item as Record<string, unknown>;
      const title = stringField(rec, "title");
      const quantity = rec.quantity;
      const price = stringField(rec, "price");
      if (title) {
        const parts = [title];
        if (typeof quantity === "number" && quantity > 1) {
          parts.push(`x${quantity}`);
        }
        if (price) {
          parts.push(`($${price})`);
        }
        lines.push(`- ${parts.join(" ")}`);
      }
    }
  }

  if (note) {
    lines.push("");
    lines.push(`**Note:** ${note}`);
  }

  const message = lines.join("\n").trim();
  const sessionKey = `webhook:shopify:order:${orderId || orderNumber || "unknown"}`;

  return { message, name: "Shopify", sessionKey };
}

function inferOrderAction(financialStatus: string, fulfillmentStatus: string): string {
  if (fulfillmentStatus === "fulfilled") {
    return "Fulfilled";
  }
  if (financialStatus === "paid") {
    return "Paid";
  }
  if (financialStatus === "refunded" || financialStatus === "partially_refunded") {
    return "Refunded";
  }
  return "Update";
}

// -- Customer --

function isCustomerPayload(payload: Record<string, unknown>): boolean {
  return (
    payload.orders_count !== undefined &&
    payload.total_spent !== undefined &&
    payload.first_name !== undefined
  );
}

function formatCustomer(payload: Record<string, unknown>): ShopifyTransformResult {
  const id = toStr(payload.id);
  const firstName = stringField(payload, "first_name");
  const lastName = stringField(payload, "last_name");
  const name = [firstName, lastName].filter(Boolean).join(" ");
  const email = stringField(payload, "email");
  const phone = stringField(payload, "phone");
  const ordersCount = payload.orders_count;
  const totalSpent = stringField(payload, "total_spent");
  const createdAt = stringField(payload, "created_at");
  const tags = stringField(payload, "tags");

  const lines: string[] = [];
  lines.push("## Shopify Customer Update");
  lines.push("");

  if (name) {
    lines.push(`**Name:** ${name}`);
  }
  if (email) {
    lines.push(`**Email:** ${email}`);
  }
  if (phone) {
    lines.push(`**Phone:** ${phone}`);
  }
  if (typeof ordersCount === "number") {
    lines.push(`**Orders:** ${ordersCount}`);
  }
  if (totalSpent) {
    lines.push(`**Total spent:** $${totalSpent}`);
  }
  if (tags) {
    lines.push(`**Tags:** ${tags}`);
  }
  if (createdAt) {
    lines.push(`**Since:** ${createdAt}`);
  }

  const message = lines.join("\n").trim();
  const sessionKey = `webhook:shopify:customer:${id || "unknown"}`;

  return { message, name: "Shopify", sessionKey };
}

// -- Product --

function isProductPayload(payload: Record<string, unknown>): boolean {
  return payload.product_type !== undefined && payload.variants !== undefined;
}

function formatProduct(payload: Record<string, unknown>): ShopifyTransformResult {
  const id = toStr(payload.id);
  const title = stringField(payload, "title");
  const productType = stringField(payload, "product_type");
  const vendor = stringField(payload, "vendor");
  const status = stringField(payload, "status");
  const variants = Array.isArray(payload.variants) ? payload.variants : [];

  const lines: string[] = [];
  lines.push("## Shopify Product Update");
  lines.push("");

  if (title) {
    lines.push(`**Product:** ${title}`);
  }
  if (productType) {
    lines.push(`**Type:** ${productType}`);
  }
  if (vendor) {
    lines.push(`**Vendor:** ${vendor}`);
  }
  if (status) {
    lines.push(`**Status:** ${status}`);
  }
  if (variants.length > 0) {
    lines.push(`**Variants:** ${variants.length}`);
  }

  const message = lines.join("\n").trim();
  const sessionKey = `webhook:shopify:product:${id || "unknown"}`;

  return { message, name: "Shopify", sessionKey };
}

// -- Refund --

function isRefundPayload(payload: Record<string, unknown>): boolean {
  return payload.order_id !== undefined && payload.refund_line_items !== undefined;
}

function formatRefund(payload: Record<string, unknown>): ShopifyTransformResult {
  const id = toStr(payload.id);
  const orderId = toStr(payload.order_id);
  const createdAt = stringField(payload, "created_at");
  const note = stringField(payload, "note");
  const refundLineItems = Array.isArray(payload.refund_line_items) ? payload.refund_line_items : [];

  const lines: string[] = [];
  lines.push("## Shopify Refund");
  lines.push("");

  if (orderId) {
    lines.push(`**Order ID:** ${orderId}`);
  }
  if (createdAt) {
    lines.push(`**Date:** ${createdAt}`);
  }
  if (note) {
    lines.push(`**Reason:** ${note}`);
  }
  if (refundLineItems.length > 0) {
    lines.push(`**Items refunded:** ${refundLineItems.length}`);
  }

  const message = lines.join("\n").trim();
  const sessionKey = `webhook:shopify:refund:${id || orderId || "unknown"}`;

  return { message, name: "Shopify", sessionKey };
}

// -- Generic fallback --

function formatGeneric(payload: Record<string, unknown>): ShopifyTransformResult {
  const id = toStr(payload.id);
  const lines: string[] = [];
  lines.push("## Shopify Event");
  lines.push("");
  lines.push(`**Entity ID:** ${id}`);

  const keys = Object.keys(payload)
    .filter((k) => k !== "id")
    .slice(0, 5);
  for (const key of keys) {
    const val = payload[key];
    if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
      lines.push(`**${key}:** ${String(val)}`);
    }
  }

  const message = lines.join("\n").trim();
  const sessionKey = `webhook:shopify:entity:${id || "unknown"}`;

  return { message, name: "Shopify", sessionKey };
}

function stringField(obj: Record<string, unknown>, key: string): string {
  const val = obj[key];
  return typeof val === "string" ? val.trim() : "";
}

function toStr(val: unknown): string {
  if (typeof val === "string") {
    return val;
  }
  if (typeof val === "number" || typeof val === "boolean") {
    return String(val);
  }
  return "";
}
