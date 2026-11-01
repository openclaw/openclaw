import { asOptionalObjectRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeStringEntries,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import { redactRegisteredSecretValues } from "../logging/secret-redaction-registry.js";
import type { JsonSchemaValidationError } from "../plugins/schema-validator.js";
import { levenshteinDistance } from "../shared/levenshtein-distance.js";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";
import { resolveAgentToolExecutionSchema } from "./agent-tool-availability.js";
import { compactToolInputHint } from "./tool-schema-hints.js";
import type {
  ToolSearchCatalogEntry,
  ToolSearchToolContext,
  UnknownToolErrorOptions,
} from "./tool-search-types.js";

function tokenizeLookupValue(input: string): Set<string> {
  return new Set(normalizeStringEntries(input.toLowerCase().split(/[^a-z0-9]+/u)));
}

function scoreUnknownToolSuggestion(
  normalizedNeedle: string,
  needleTokens: ReadonlySet<string>,
  entry: ToolSearchCatalogEntry,
): number {
  const name = entry.name.toLowerCase();
  const id = entry.id.toLowerCase();
  const label = (entry.label ?? "").toLowerCase();
  const description = entry.description.toLowerCase();
  const entryTokens = tokenizeLookupValue(
    `${entry.name} ${entry.id} ${entry.label ?? ""} ${entry.description}`,
  );
  let score = 0;
  if ((name && normalizedNeedle.includes(name)) || id.includes(normalizedNeedle)) {
    score += 40;
  }
  if (name && needleTokens.has(name)) {
    score += 40;
  }
  for (const token of needleTokens) {
    if (entryTokens.has(token)) {
      score += 12;
    }
  }
  if (label.includes(normalizedNeedle) || description.includes(normalizedNeedle)) {
    score += 8;
  }
  return score;
}

export type ToolLookupErrorOptions = UnknownToolErrorOptions &
  Pick<ToolSearchToolContext, "codeModeSkills">;

export function formatUnknownToolIdError(
  needle: string,
  entries: readonly ToolSearchCatalogEntry[],
  options: ToolLookupErrorOptions = {},
): string {
  const skill = options.codeModeSkills?.find((candidate) => candidate.name === needle);
  const canReadSkills = entries.some(
    (entry) =>
      entry.source === "openclaw" &&
      entry.sourceName === "core" &&
      (entry.name === "read" || entry.name === "skills_read"),
  );
  if (skill && canReadSkills) {
    // Use admitted, mapped prompt locations; never load a skill as a side effect of recovery.
    const quotedLocation = JSON.stringify(skill.location);
    const location = quotedLocation.length <= 1_024 ? quotedLocation : "its listed location";
    return `This id names a skill, not a callable tool. Load its complete instructions from ${location} using the skill-loading guidance in your system prompt.`;
  }
  const nameCounts = new Map<string, number>();
  for (const entry of entries) {
    nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
  }
  const normalizedNeedle = needle.toLowerCase();
  const needleTokens = tokenizeLookupValue(needle);
  const suggestions = uniqueStrings(
    entries
      .map((entry) => ({
        value:
          options.exactIdOnly || entry.requiresExactId || (nameCounts.get(entry.name) ?? 0) > 1
            ? entry.id
            : entry.name,
        score: scoreUnknownToolSuggestion(normalizedNeedle, needleTokens, entry),
      }))
      .filter((candidate) => candidate.score > 0)
      .toSorted((a, b) => b.score - a.score || a.value.localeCompare(b.value))
      .map((candidate) => candidate.value),
  ).slice(0, 3);
  const recoveryText =
    options.recoverySurface === "catalog"
      ? "Use catalog.search to find a callable tool handle, then call the handle or use its describe method."
      : "Use tool_search to find a tool, tool_describe to inspect it, then dispatch_action with the exact id or name.";
  if (suggestions.length === 0) {
    return `Unknown tool id: ${needle}. ${recoveryText}`;
  }
  return `Unknown tool id: ${needle}. Did you mean: ${suggestions.join(", ")}? ${recoveryText}`;
}

const MAX_INPUT_ERROR_DETAILS = 5;
const SENSITIVE_INPUT_PATH =
  /(?:auth|card|code|cookie|credential|cvc|cvv|key|pass|pin|secret|session|signature|token)/iu;
const SCALAR_STRING = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)$/u;

function receivedInputHint(value: unknown, path: readonly string[]): string {
  let received = value;
  for (const segment of path) {
    const record = asOptionalObjectRecord(received);
    received = record && Object.hasOwn(record, segment) ? record[segment] : undefined;
  }
  const type = received === null ? "null" : Array.isArray(received) ? "array" : typeof received;
  let preview = "[redacted]";
  if (!path.some((segment) => SENSITIVE_INPUT_PATH.test(segment))) {
    // Arbitrary text and container contents can carry secrets under innocuous names.
    // Only short JSON scalar strings are useful enough to echo (notably quoted numbers).
    if (typeof received === "string") {
      if (received.length <= 64 && SCALAR_STRING.test(received)) {
        preview = JSON.stringify(received);
      }
    } else if (received === null || ["number", "boolean", "undefined"].includes(type)) {
      preview = String(received);
    } else if (type === "array" || type === "object") {
      preview = `[${type}]`;
    }
  }
  if (redactRegisteredSecretValues(preview, () => "[redacted]") !== preview) {
    preview = "[redacted]";
  }
  return `received ${preview} (${type})`;
}

export function formatCatalogInputError(
  entry: ToolSearchCatalogEntry,
  errors: JsonSchemaValidationError[],
  value: unknown,
): string {
  const executionSchema = resolveAgentToolExecutionSchema(entry.tool, entry.parameters);
  const schema = isRecord(executionSchema) ? executionSchema : undefined;
  const propertyNames = isRecord(schema?.properties) ? Object.keys(schema.properties) : [];
  const knownProperties = new Set(propertyNames);
  const unexpectedProperties =
    schema?.additionalProperties === false && isRecord(value)
      ? Object.keys(value).filter((name) => !knownProperties.has(name))
      : errors.flatMap((error) => (error.additionalProperty ? [error.additionalProperty] : []));
  const suggestions = uniqueStrings(
    unexpectedProperties.slice(0, MAX_INPUT_ERROR_DETAILS).flatMap((unexpected) => {
      if (unexpected.length > 128) {
        return [];
      }
      const maxDistance = Math.min(3, Math.max(1, Math.ceil(unexpected.length / 3)));
      const nearest = propertyNames
        .filter((name) => name.length <= 128)
        .map((name) => ({
          name,
          distance: levenshteinDistance(unexpected, name, maxDistance) ?? Number.POSITIVE_INFINITY,
        }))
        .filter(({ distance }) => distance <= maxDistance)
        .toSorted(
          (left, right) => left.distance - right.distance || left.name.localeCompare(right.name),
        )[0];
      return nearest ? [nearest.name] : [];
    }),
  ).slice(0, 3);
  const details = errors.slice(0, MAX_INPUT_ERROR_DETAILS).map((error) => {
    const expected = error.text.replace(
      /: must be (integer|string|number|boolean|object|array|null)$/u,
      ": expected $1",
    );
    const received = error.valuePath ? `; ${receivedInputHint(value, error.valuePath)}` : "";
    const detail = redactRegisteredSecretValues(`${expected}${received}`, () => "[redacted]");
    const prefix = truncateUtf8Prefix(detail, 256);
    return prefix === detail ? detail : `${prefix} [truncated]`;
  });
  if (errors.length > details.length) {
    details.push(`${errors.length - details.length} additional validation issues omitted`);
  }
  const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
  const input = compactToolInputHint(schema);
  const signature = input === "unknown" ? "" : ` Expected input: ${input}.`;
  return `Invalid arguments for tool "${entry.id}": ${details.join("; ")}.${hint}${signature}`;
}

export function formatCatalogOutputError(
  entry: ToolSearchCatalogEntry,
  errors: import("../plugins/schema-validator.js").JsonSchemaValidationError[],
): string {
  const details = errors.slice(0, 5).map(({ text }) => {
    const prefix = truncateUtf8Prefix(text, 256);
    return prefix === text ? text : `${prefix} [truncated]`;
  });
  if (errors.length > details.length) {
    details.push(`${errors.length - details.length} additional validation issues omitted`);
  }
  return (
    `Tool "${entry.id}" returned details that do not match its declared outputSchema. ` +
    "Check current state before retrying; the tool returned and side effects may already have occurred. " +
    `Validation: ${details.join("; ")}.`
  );
}
