// Frozen pre-optimization SQL: an independent byte oracle for the PostgreSQL read rewrite.
import { sql, type Expression, type RawBuilder } from "kysely";
import {
  LEGACY_MISSING_TOOL_RESULT_TEXT,
  SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY,
} from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import {
  jsonArrayElements,
  jsonArrayValue,
  jsonObjectValue,
  jsonOrderedArray,
  jsonPathValue,
  jsonPickObject,
  jsonRemovePaths,
  jsonSetPath,
  jsonType,
} from "../../infra/database-engine/json-values.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { MODEL_CONTEXT_PRIVATE_METADATA_KEYS } from "../../shared/model-context-message.js";
import {
  MODEL_CONTEXT_NAVIGATION_KEYS,
  MODEL_MESSAGE_NAVIGATION_KEYS,
} from "./session-model-context-navigation.js";

export function legacyModelContextEventSql(
  db: EngineConnection,
  event: Expression<string | Uint8Array>,
  omitCheckpoint: Expression<number>,
  toolResultOmission?: Expression<string | null>,
  role: Expression<unknown> = jsonPathValue(db, event, sql.lit("$.message.role")),
): RawBuilder<string> {
  const paths = MODEL_CONTEXT_PRIVATE_METADATA_KEYS.map((key) => `$.message.__openclaw.${key}`);
  const projected = jsonRemovePaths(
    db,
    event,
    paths.map((path) => sql.val(path)),
  );
  const modelEvent = /* kysely-allow-raw: tool result details are not model input; other details can be runtime context. */ sql<string>`CASE WHEN ${role} = 'toolResult'
    THEN ${jsonRemovePaths(db, projected, [sql.lit("$.message.details")])} ELSE ${projected} END`;
  const boundedEvent = toolResultOmission
    ? /* kysely-allow-raw: omit only selected result bodies before hydration; durable rows remain unchanged. */ sql<string>`CASE WHEN ${toolResultOmission} IS NOT NULL AND ${role} = 'toolResult'
      THEN ${jsonSetPath(
        db,
        modelEvent,
        sql.lit("$.message.content"),
        jsonArrayValue(db, [
          jsonObjectValue(db, { type: sql.lit("text"), text: toolResultOmission }),
        ]),
        true,
      )} ELSE ${modelEvent} END`
    : modelEvent;
  // The context owner classifies invalidated prefix checkpoints using the transport
  // contract. Other replay state must survive, including checkpoints after the cut.
  return /* kysely-allow-raw: exclude invalidated replay before hydrating a retained prefix. */ sql<string>`CASE WHEN ${omitCheckpoint} = 1
    THEN ${jsonRemovePaths(db, boundedEvent, [sql.lit("$.message.providerReplay")])} ELSE ${boundedEvent} END`;
}

function systemUpdateKindSql(
  db: EngineConnection,
  event: Expression<unknown>,
): RawBuilder<string | null> {
  return /* kysely-allow-raw: only bounded operator kinds cross the navigation boundary. */ sql<
    string | null
  >`CASE
    WHEN ${jsonPathValue(db, event, sql.lit("$.customType"))} = 'openclaw.system-update'
      AND ${jsonPathValue(db, event, sql.lit("$.details.kind"))} IN ('prompt-update', 'runtime-context')
    THEN ${jsonPathValue(db, event, sql.lit("$.details.kind"))} ELSE NULL END`;
}

export function legacyModelNavigationSql(
  db: EngineConnection,
  event: Expression<unknown>,
  entryType: Expression<unknown>,
): RawBuilder<string> {
  const get = (path: string) => jsonPathValue(db, event, sql.lit(path));
  const entry = jsonPickObject(db, event, MODEL_CONTEXT_NAVIGATION_KEYS);
  const message = jsonPathValue(db, event, sql.lit("$.message"), "json");
  const content = jsonPathValue(db, event, sql.lit("$.message.content"), "json");
  const elements = jsonArrayElements(
    db,
    sql`CASE WHEN ${jsonType(db, content)} = 'array' THEN ${content} ELSE '[]' END`,
  );
  const value =
    /* kysely-allow-raw: Closed value column from the array expansion above. */ sql.ref<string>(
      "value",
    );
  const property = (key: string) => jsonPathValue(db, value, sql.lit(`$.${key}`));
  const calls = /* kysely-allow-raw: Project ordered tool identities without their argument bodies. */ sql<string>`(SELECT ${jsonOrderedArray(db, jsonObjectValue(db, { type: property("type"), id: property("id"), name: property("name") }), [])}
    FROM ${elements} WHERE ${jsonType(db, value)} = 'object'
    AND ${property("type")} IN ('toolCall', 'toolUse', 'functionCall'))`;
  const synthetic = sql`coalesce(${jsonPathValue(db, event, sql.lit(`$.message.details.${SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY}`), "json")}, 'false') IN ('true', '1') OR EXISTS (
    SELECT 1 FROM ${elements} WHERE ${property("type")} = 'text' AND ${property("text")} = ${LEGACY_MISSING_TOOL_RESULT_TEXT})`;
  const kind = systemUpdateKindSql(db, message);
  const missing = { [SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY]: synthetic };
  let projectedMessage = jsonPickObject(db, message, MODEL_MESSAGE_NAVIGATION_KEYS);
  for (const [path, replacement, json] of [
    ["content", calls, true],
    ["command", sql.lit(""), false],
    ["output", sql.lit(""), false],
    ["providerReplay", jsonObjectValue(db, { type: get("$.message.providerReplay.type") }), true],
    [
      "details",
      /* kysely-allow-raw: Optional operator kind preserves the JSON object shape. */ sql<string>`CASE WHEN ${kind} IS NULL THEN ${jsonObjectValue(db, missing)} ELSE ${jsonObjectValue(db, { ...missing, kind })} END`,
      true,
    ],
  ] as const) {
    projectedMessage = jsonSetPath(db, projectedMessage, sql.lit(`$.${path}`), replacement, json);
  }
  const custom = jsonSetPath(db, entry, sql.lit("$.content"), sql.lit("[]"), true);
  const customKind = systemUpdateKindSql(db, event);
  return /* kysely-allow-raw: Discriminated model navigation projection excludes opaque payloads. */ sql<string>`CASE ${entryType}
    WHEN 'message' THEN ${jsonSetPath(db, entry, sql.lit("$.message"), projectedMessage, true)}
    WHEN 'custom_message' THEN CASE WHEN ${customKind} IS NULL THEN ${custom}
      ELSE ${jsonSetPath(db, custom, sql.lit("$.details"), jsonObjectValue(db, { kind: customKind }), true)} END
    WHEN 'custom' THEN CASE WHEN ${get("$.customType")} = 'openclaw.system-prompt'
      THEN ${jsonSetPath(db, entry, sql.lit("$.data"), jsonObjectValue(db, { restart: sql`coalesce(${jsonPathValue(db, event, sql.lit("$.data.restart"), "json")}, 'false') = 'true'` }), true)}
      ELSE ${entry} END
    WHEN 'compaction' THEN ${jsonSetPath(db, entry, sql.lit("$.summary"), sql.lit(""))}
    WHEN 'branch_summary' THEN ${jsonSetPath(db, entry, sql.lit("$.summary"), sql.lit(""))}
    ELSE ${entry} END`;
}
