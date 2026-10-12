import {
  readJsonPredicateScalar,
  scanJsonObjectFields,
  type JsonPredicateToken,
} from "../../state/json-predicate-fields.js";

export type TranscriptPredicateFields = {
  navigation_type: string | null;
  navigation_custom_type: string | null;
  navigation_display: number;
  message_role: string | null;
  navigation_last_type: string | null;
  navigation_last_custom_type: string | null;
  navigation_valid: number;
};

const eventTypes = new Set([
  "session",
  "message",
  "reset",
  "compaction",
  "custom_message",
  "custom",
]);
const customTypes = new Set(["openclaw.runtime-context", "openclaw.cache-ttl"]);
const messageRoles = new Set(["user", "assistant", "toolResult", "system"]);

function discriminator(token: JsonPredicateToken | undefined, values: ReadonlySet<string>) {
  const value = readJsonPredicateScalar(token);
  return typeof value === "string" && values.has(value) ? value : null;
}

/** Query-only discriminators preserve SQLite's first member and legacy JS's last member. */
export function deriveTranscriptPredicateFields(eventJson: string): TranscriptPredicateFields {
  const fields = scanJsonObjectFields(eventJson, ["type", "customType", "display", "message"]);
  if (!fields.valid || fields.maximumDepth > 1000) {
    return {
      navigation_type: null,
      navigation_custom_type: null,
      navigation_display: 0,
      message_role: null,
      navigation_last_type: null,
      navigation_last_custom_type: null,
      navigation_valid: 0,
    };
  }
  const message = fields.first.get("message");
  const role =
    message?.kind === "object"
      ? scanJsonObjectFields(message.text, ["role"]).first.get("role")
      : undefined;
  return {
    navigation_type: discriminator(fields.first.get("type"), eventTypes),
    navigation_custom_type: discriminator(fields.first.get("customType"), customTypes),
    navigation_display: readJsonPredicateScalar(fields.first.get("display")) === true ? 1 : 0,
    message_role: discriminator(role, messageRoles),
    navigation_last_type: discriminator(fields.last.get("type"), eventTypes),
    navigation_last_custom_type: discriminator(fields.last.get("customType"), customTypes),
    navigation_valid: 1,
  };
}

/** Corrupt navigation must fail a selected read instead of becoming an empty result. */
export function assertTranscriptNavigationValid(valid: number | undefined): void {
  if (valid === 0) {
    throw new Error(
      "malformed JSON in transcript navigation; run openclaw doctor to inspect the agent database",
    );
  }
}
