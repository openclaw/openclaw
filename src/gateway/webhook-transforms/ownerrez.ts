export type OwnerRezTransformResult = {
  message: string;
  name: string;
  sessionKey: string;
} | null;

/**
 * Transforms an OwnerRez webhook payload into an agent message.
 *
 * OwnerRez webhooks send a JSON body with fields:
 * - id: unique payload id (for dedup)
 * - user_id: OwnerRez user id
 * - action: "entity_insert" | "entity_update" | "entity_delete" | "application_authorization_revoked"
 * - entity_type: "booking" | "contact" | "property" | etc.
 * - entity_id: the id of the affected entity
 * - categories: array of strings categorizing the change
 * - entity: optional embedded object with the full entity data
 */
export function transformOwnerRezPayload(
  payload: Record<string, unknown>,
): OwnerRezTransformResult {
  const action = stringField(payload, "action");
  if (!action) {
    return null;
  }

  // Handle authorization revoked separately
  if (action === "application_authorization_revoked") {
    return {
      message: "## OwnerRez\n\nApplication authorization has been revoked.",
      name: "OwnerRez",
      sessionKey: `webhook:ownerrez:auth-revoked:${stringField(payload, "user_id") || "unknown"}`,
    };
  }

  // Must be an entity action
  if (!action.startsWith("entity_")) {
    return null;
  }

  const entityType = stringField(payload, "entity_type");
  const entityId = stringField(payload, "entity_id");
  if (!entityType) {
    return null;
  }

  const operation = parseOperation(action);
  const label = ENTITY_LABELS[entityType.toLowerCase()] || capitalize(entityType);
  const categories = Array.isArray(payload.categories) ? payload.categories : [];
  const entity =
    typeof payload.entity === "object" && payload.entity !== null
      ? (payload.entity as Record<string, unknown>)
      : null;

  const lines: string[] = [];
  lines.push(`## OwnerRez: ${label} ${operation}`);
  lines.push("");

  if (entityId) {
    lines.push(`**${label} ID:** ${entityId}`);
  }

  if (categories.length > 0) {
    const categoryStrings: string[] = categories.filter((c): c is string => typeof c === "string");
    if (categoryStrings.length > 0) {
      lines.push(`**Categories:** ${categoryStrings.join(", ")}`);
    }
  }

  // Extract useful details from embedded entity
  if (entity && entityType.toLowerCase() === "booking") {
    formatBookingEntity(entity, lines);
  } else if (entity && entityType.toLowerCase() === "contact") {
    formatContactEntity(entity, lines);
  }

  const payloadId = stringField(payload, "id");
  const message = lines.join("\n").trim();
  const sessionKey = `webhook:ownerrez:${entityType}:${entityId || payloadId || "unknown"}`;

  return { message, name: "OwnerRez", sessionKey };
}

function formatBookingEntity(entity: Record<string, unknown>, lines: string[]) {
  const arrival = stringField(entity, "arrival");
  const departure = stringField(entity, "departure");
  const adults = entity.adults;
  const children = entity.children;
  const status = stringField(entity, "status");
  const guestName =
    stringField(entity, "guest_name") ||
    stringField(entity, "guest_first_name") ||
    stringField(entity, "name");
  const propertyName = stringField(entity, "property_name");
  const totalAmountRaw = entity.total_amount ?? entity.total;
  const totalAmount =
    typeof totalAmountRaw === "string" || typeof totalAmountRaw === "number"
      ? String(totalAmountRaw)
      : "";
  const currency = stringField(entity, "currency");
  const bookedUtc = stringField(entity, "booked_utc");
  const source = stringField(entity, "source") || stringField(entity, "channel_name");

  lines.push("");

  if (guestName) {
    lines.push(`**Guest:** ${guestName}`);
  }
  if (propertyName) {
    lines.push(`**Property:** ${propertyName}`);
  }
  if (arrival || departure) {
    const range = [arrival, departure].filter(Boolean).join(" to ");
    lines.push(`**Dates:** ${range}`);
  }
  if (typeof adults === "number" || typeof children === "number") {
    const parts: string[] = [];
    if (typeof adults === "number") {
      parts.push(`${adults} adult${adults !== 1 ? "s" : ""}`);
    }
    if (typeof children === "number" && children > 0) {
      parts.push(`${children} child${children !== 1 ? "ren" : ""}`);
    }
    lines.push(`**Guests:** ${parts.join(", ")}`);
  }
  if (status) {
    lines.push(`**Status:** ${status}`);
  }
  if (totalAmount) {
    const formatted = currency ? `${totalAmount} ${currency}` : totalAmount;
    lines.push(`**Total:** ${formatted}`);
  }
  if (source) {
    lines.push(`**Source:** ${source}`);
  }
  if (bookedUtc) {
    lines.push(`**Booked:** ${bookedUtc}`);
  }
}

function formatContactEntity(entity: Record<string, unknown>, lines: string[]) {
  const firstName = stringField(entity, "first_name");
  const lastName = stringField(entity, "last_name");
  const email = stringField(entity, "email") || stringField(entity, "email_address");
  const phone = stringField(entity, "phone") || stringField(entity, "phone_number");
  const name = [firstName, lastName].filter(Boolean).join(" ") || stringField(entity, "name");

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
}

function parseOperation(action: string): string {
  switch (action) {
    case "entity_insert":
      return "Created";
    case "entity_update":
      return "Updated";
    case "entity_delete":
      return "Deleted";
    default:
      return capitalize(action.replace("entity_", ""));
  }
}

function capitalize(str: string): string {
  if (!str) {
    return str;
  }
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stringField(obj: Record<string, unknown>, key: string): string {
  const val = obj[key];
  return typeof val === "string" ? val.trim() : "";
}

const ENTITY_LABELS: Record<string, string> = {
  booking: "Booking",
  contact: "Contact",
  property: "Property",
  block: "Block",
  quote: "Quote",
  inquiry: "Inquiry",
  review: "Review",
  owner_statement: "Owner Statement",
  expense: "Expense",
  charge: "Charge",
  payment: "Payment",
  refund: "Refund",
  message: "Message",
  task: "Task",
  note: "Note",
};
