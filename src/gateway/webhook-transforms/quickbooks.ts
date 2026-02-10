export type QuickBooksTransformResult = {
  message: string;
  name: string;
  sessionKey: string;
} | null;

/**
 * Transforms a QuickBooks Online webhook payload into an agent message.
 *
 * Supports both the legacy format (`eventNotifications`) and the new
 * CloudEvents format (array of CloudEvents objects, migrating by May 2026).
 */
export function transformQuickBooksPayload(
  payload: Record<string, unknown>,
): QuickBooksTransformResult {
  // Try CloudEvents format first (array at top level comes through as payload wrapper)
  const cloudEvents = extractCloudEvents(payload);
  if (cloudEvents.length > 0) {
    return formatCloudEvents(cloudEvents);
  }

  // Legacy format: { eventNotifications: [...] }
  const notifications = extractLegacyNotifications(payload);
  if (notifications.length > 0) {
    return formatLegacyNotifications(notifications);
  }

  return null;
}

// -- Legacy format parsing --

type LegacyEntity = {
  id: string;
  name: string;
  operation: string;
  lastUpdated: string;
};

type LegacyNotification = {
  realmId: string;
  entities: LegacyEntity[];
};

function extractLegacyNotifications(payload: Record<string, unknown>): LegacyNotification[] {
  const raw = payload.eventNotifications;
  if (!Array.isArray(raw)) {
    return [];
  }
  const results: LegacyNotification[] = [];
  for (const notification of raw) {
    if (typeof notification !== "object" || notification === null) {
      continue;
    }
    const rec = notification as Record<string, unknown>;
    const realmId = typeof rec.realmId === "string" ? rec.realmId : "";
    const dataChangeEvent = rec.dataChangeEvent as Record<string, unknown> | undefined;
    if (!dataChangeEvent || !Array.isArray(dataChangeEvent.entities)) {
      continue;
    }
    const entities: LegacyEntity[] = [];
    for (const entity of dataChangeEvent.entities) {
      if (typeof entity !== "object" || entity === null) {
        continue;
      }
      const e = entity as Record<string, unknown>;
      entities.push({
        id: typeof e.id === "string" ? e.id : "",
        name: typeof e.name === "string" ? e.name : "",
        operation: typeof e.operation === "string" ? e.operation : "",
        lastUpdated: typeof e.lastUpdated === "string" ? e.lastUpdated : "",
      });
    }
    if (entities.length > 0) {
      results.push({ realmId, entities });
    }
  }
  return results;
}

function formatLegacyNotifications(notifications: LegacyNotification[]): QuickBooksTransformResult {
  const allEntities: Array<LegacyEntity & { realmId: string }> = [];
  for (const n of notifications) {
    for (const e of n.entities) {
      allEntities.push({ ...e, realmId: n.realmId });
    }
  }
  if (allEntities.length === 0) {
    return null;
  }

  const lines: string[] = [];
  lines.push("## QuickBooks Update");
  lines.push("");

  const realmIds = [...new Set(allEntities.map((e) => e.realmId).filter(Boolean))];
  if (realmIds.length === 1) {
    lines.push(`**Company ID:** ${realmIds[0]}`);
    lines.push("");
  }

  if (allEntities.length === 1) {
    const e = allEntities[0];
    lines.push(formatEntityLine(e.name, e.operation, e.id, e.lastUpdated));
    if (realmIds.length > 1) {
      lines.push(`  Company ID: ${e.realmId}`);
    }
  } else {
    lines.push("### Events");
    lines.push("");
    for (const e of allEntities) {
      lines.push(`- ${formatEntityLine(e.name, e.operation, e.id, e.lastUpdated)}`);
    }
  }

  const message = lines.join("\n").trim();
  const sessionKey = deriveSessionKey(allEntities.map((e) => `${e.name}:${e.id}:${e.operation}`));

  return { message, name: "QuickBooks", sessionKey };
}

// -- CloudEvents format parsing --

type CloudEvent = {
  id: string;
  type: string;
  time: string;
  entityId: string;
  accountId: string;
};

function extractCloudEvents(payload: Record<string, unknown>): CloudEvent[] {
  // CloudEvents come as a top-level array, but since our webhook handler
  // parses JSON and the result may be an array wrapped in an object,
  // we also check for a direct array. The webhook handler coerces non-object
  // values to {}, so for a top-level array the caller needs to send it
  // as the body. We check both "events" wrapper and the array indicators.
  let rawEvents: unknown[] = [];

  // Direct array payload (if somehow preserved)
  if (Array.isArray(payload)) {
    rawEvents = payload;
  }
  // Wrapped in an "events" key
  else if (Array.isArray(payload.events)) {
    rawEvents = payload.events;
  }
  // Check if it looks like a single CloudEvent
  else if (typeof payload.specversion === "string" && typeof payload.type === "string") {
    rawEvents = [payload];
  }

  const results: CloudEvent[] = [];
  for (const event of rawEvents) {
    if (typeof event !== "object" || event === null) {
      continue;
    }
    const rec = event as Record<string, unknown>;
    if (typeof rec.specversion !== "string" || typeof rec.type !== "string") {
      continue;
    }
    results.push({
      id: typeof rec.id === "string" ? rec.id : "",
      type: typeof rec.type === "string" ? rec.type : "",
      time: typeof rec.time === "string" ? rec.time : "",
      entityId: typeof rec.intuitentityid === "string" ? rec.intuitentityid : "",
      accountId: typeof rec.intuitaccountid === "string" ? rec.intuitaccountid : "",
    });
  }
  return results;
}

function formatCloudEvents(events: CloudEvent[]): QuickBooksTransformResult {
  if (events.length === 0) {
    return null;
  }

  const lines: string[] = [];
  lines.push("## QuickBooks Update");
  lines.push("");

  const accountIds = [...new Set(events.map((e) => e.accountId).filter(Boolean))];
  if (accountIds.length === 1) {
    lines.push(`**Company ID:** ${accountIds[0]}`);
    lines.push("");
  }

  if (events.length === 1) {
    const e = events[0];
    const parsed = parseCloudEventType(e.type);
    lines.push(formatEntityLine(parsed.entity, parsed.operation, e.entityId, e.time));
  } else {
    lines.push("### Events");
    lines.push("");
    for (const e of events) {
      const parsed = parseCloudEventType(e.type);
      lines.push(`- ${formatEntityLine(parsed.entity, parsed.operation, e.entityId, e.time)}`);
    }
  }

  const message = lines.join("\n").trim();
  const sessionKey = deriveSessionKey(events.map((e) => `${e.type}:${e.entityId}`));

  return { message, name: "QuickBooks", sessionKey };
}

/**
 * Parse CloudEvents type string like "qbo.invoice.created.v1"
 * into { entity: "Invoice", operation: "Created" }
 */
function parseCloudEventType(type: string): { entity: string; operation: string } {
  const parts = type.split(".");
  // Expected: namespace.entity.operation.version (e.g., qbo.invoice.created.v1)
  const entity = parts.length >= 2 ? capitalize(parts[1]) : type;
  const operation = parts.length >= 3 ? capitalize(parts[2]) : "Unknown";
  return { entity, operation };
}

// -- Shared helpers --

function formatEntityLine(name: string, operation: string, id: string, timestamp: string): string {
  const label = ENTITY_LABELS[name.toLowerCase()] || name;
  const parts = [`**${label}** ${operation}`];
  if (id) {
    parts.push(`(ID: ${id})`);
  }
  if (timestamp) {
    parts.push(`at ${timestamp}`);
  }
  return parts.join(" ");
}

function deriveSessionKey(parts: string[]): string {
  // Use a stable key based on the first entity so related updates group together
  const base = parts[0] || "unknown";
  return `webhook:quickbooks:${base}`;
}

function capitalize(str: string): string {
  if (!str) {
    return str;
  }
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/** Human-readable labels for common QuickBooks entity names */
const ENTITY_LABELS: Record<string, string> = {
  invoice: "Invoice",
  bill: "Bill",
  payment: "Payment",
  customer: "Customer",
  vendor: "Vendor",
  estimate: "Estimate",
  account: "Account",
  item: "Item",
  creditmemo: "Credit Memo",
  salesreceipt: "Sales Receipt",
  purchaseorder: "Purchase Order",
  purchase: "Purchase",
  journalentry: "Journal Entry",
  deposit: "Deposit",
  transfer: "Transfer",
  refundreceipt: "Refund Receipt",
  billpayment: "Bill Payment",
  vendorcredit: "Vendor Credit",
  timeactivity: "Time Activity",
  employee: "Employee",
  class: "Class",
  department: "Department",
  taxcode: "Tax Code",
  taxrate: "Tax Rate",
  term: "Term",
  paymentmethod: "Payment Method",
  budget: "Budget",
};
