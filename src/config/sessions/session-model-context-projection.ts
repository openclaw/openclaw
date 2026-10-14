import type { DatabaseSync } from "node:sqlite";
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
  jsonValid,
} from "../../infra/database-engine/json-values.js";
import { supportsNodeSqliteJsonb } from "../../infra/node-sqlite.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import { MODEL_CONTEXT_PRIVATE_METADATA_KEYS } from "../../shared/model-context-message.js";
import {
  MODEL_CONTEXT_NAVIGATION_KEYS,
  MODEL_MESSAGE_NAVIGATION_KEYS,
  TRANSCRIPT_NAVIGATION_KEYS,
} from "./session-model-context-navigation.js";

/** Exclude storage-only fields in SQLite, before a row's JSON crosses into JavaScript. */
export function projectModelContextEventSql(
  db: DatabaseSync,
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

function contentPropertySql(
  event: Expression<string | Uint8Array>,
  property: "type" | "id" | "name" | "text",
): RawBuilder<unknown> {
  // Root lookups rescan array prefixes, so keep them bounded. Later elements and
  // potentially duplicated object keys retain their own json_each value.
  return /* kysely-allow-raw: bounded array paths avoid serializing and reparsing whole content objects. */ sql`CASE WHEN typeof(key) = 'integer' AND key < 8
    THEN json_extract(${event}, fullkey || ${`.${property}`})
    ELSE json_extract(value, ${`$.${property}`}) END`;
}

type JsonMemberAlias = "root_member" | "message_member";

function jsonMemberValue(alias: JsonMemberAlias): RawBuilder<unknown> {
  const type =
    /* kysely-allow-raw: closed aliases are JSON member cursors created below. */ sql.ref(
      `${alias}.type`,
    );
  const value =
    /* kysely-allow-raw: closed aliases are JSON member cursors created below. */ sql.ref(
      `${alias}.value`,
    );
  return sql`CASE ${type}
    WHEN 'object' THEN json(${value})
    WHEN 'array' THEN json(${value})
    WHEN 'true' THEN json('true') WHEN 'false' THEN json('false')
    ELSE ${value} END`;
}

/** Stored navigation serves SQL's first-key lookup and JavaScript's last-key parse. */
export function projectTranscriptPayloadNavigationSql(
  db: DatabaseSync,
  event: Expression<string | Uint8Array>,
): RawBuilder<string> {
  const memberValue =
    /* kysely-allow-raw: fixed JSON member cursor declared in the message projection below. */ sql.ref(
      "message_member.value",
    );
  const internal = jsonPickObject(db, memberValue, [
    "runId",
    "steerTargetRunId",
    "contextFreeCommand",
  ]);
  const message = /* kysely-allow-raw: preserve duplicate message/internal envelopes in native member order. */ sql<string>`(SELECT json_group_object(message_member.key,
    CASE WHEN message_member.key = '__openclaw' AND message_member.type = 'object'
      THEN json(${internal}) ELSE ${jsonMemberValue("message_member")} END)
    FROM json_each(root_member.value) AS message_member
    WHERE message_member.key IN ('role', 'idempotencyKey', 'provenance', 'excludeFromContext', '__openclaw'))`;
  return /* kysely-allow-raw: preserve duplicate root keys and nested SQL types while selecting bounded navigation. */ sql<string>`(SELECT json_group_object(root_member.key,
    CASE WHEN root_member.key = 'message' AND root_member.type = 'object'
      THEN json(${message}) ELSE ${jsonMemberValue("root_member")} END)
    FROM json_each(${event}) AS root_member
    WHERE root_member.key IN (${sql.join([...MODEL_CONTEXT_NAVIGATION_KEYS, "message"])}))`;
}

/** Cursor resolution needs only tree facts, even when a row has an opaque body. */
export function projectTranscriptNavigationSql(
  db: DatabaseSync,
  event: Expression<string>,
): RawBuilder<string> {
  return jsonPickObject(db, event, TRANSCRIPT_NAVIGATION_KEYS);
}

/** Reset boundaries select ancestry and replay roles without loading message bodies. */
export function projectResetBoundaryNavigationSql(
  db: DatabaseSync,
  event: Expression<string>,
): RawBuilder<string> {
  const entry = jsonPickObject(db, event, [
    ...TRANSCRIPT_NAVIGATION_KEYS,
    "timestamp",
    "firstKeptEntryId",
    "customType",
    "display",
  ]);
  // Malformed rows must reach JSON.parse unchanged; CASE guards the native projection.
  return /* kysely-allow-raw: reset planning uses navigation metadata, never durable transcript payloads. */ sql<string>`CASE WHEN ${jsonValid(db, event)} THEN
    CASE WHEN ${jsonType(db, event)} = 'object' THEN
      ${jsonSetPath(
        db,
        entry,
        sql.lit("$.message"),
        jsonObjectValue(db, {
          role: jsonPathValue(db, event, sql.lit("$.message.role")),
        }),
        true,
      )}
    ELSE ${event} END
    ELSE ${event} END`;
}

function systemUpdateKindSql(
  db: DatabaseSync,
  event: Expression<unknown>,
): RawBuilder<string | null> {
  return /* kysely-allow-raw: only bounded operator kinds cross the navigation boundary. */ sql<
    string | null
  >`CASE
    WHEN ${jsonPathValue(db, event, sql.lit("$.customType"))} = 'openclaw.system-update'
      AND ${jsonPathValue(db, event, sql.lit("$.details.kind"))} IN ('prompt-update', 'runtime-context')
    THEN ${jsonPathValue(db, event, sql.lit("$.details.kind"))} ELSE NULL END`;
}

/** Lightweight tree/state records; these never serve as persisted transcript evidence. */
export function projectModelContextNavigationSql(
  db: DatabaseSync,
  event: Expression<string | Uint8Array>,
  entryType: Expression<unknown> = jsonPathValue(db, event, sql.lit("$.type")),
): RawBuilder<string> {
  if (isPostgresSqlConnection(db)) {
    return postgresModelNavigationSql(db, event, entryType);
  }
  const entry = jsonPickObject(db, event, MODEL_CONTEXT_NAVIGATION_KEYS);
  // Binary intermediates avoid serializing and reparsing the entire message.
  const message = supportsNodeSqliteJsonb()
    ? /* kysely-allow-raw: JSONB remains inside SQLite; durable transcript bytes stay text. */ sql`jsonb_extract(${event}, '$.message')`
    : /* kysely-allow-raw: supported SQLite 3.44 libraries retain text JSON extraction. */ sql`json_extract(${event}, '$.message')`;
  const messageFacts = jsonPickObject(db, message, MODEL_MESSAGE_NAVIGATION_KEYS);
  const messageOperatorKind = systemUpdateKindSql(db, message);
  const entryOperatorKind = systemUpdateKindSql(db, event);
  const customMessage = /* kysely-allow-raw: custom-message navigation omits payload text. */ sql<string>`json_set(${entry}, '$.content', json('[]'))`;
  const calls = /* kysely-allow-raw: pairing needs call identities, never tool arguments or result bodies. */ sql<string>`(SELECT json_group_array(json_object(
    'type', ${contentPropertySql(event, "type")}, 'id', ${contentPropertySql(event, "id")},
    'name', ${contentPropertySql(event, "name")}))
    FROM json_each(${event}, '$.message.content') WHERE type = 'object'
    AND ${contentPropertySql(event, "type")} IN ('toolCall', 'toolUse', 'functionCall'))`;
  const synthetic = /* kysely-allow-raw: pairing prefers real results over synthetic missing-result placeholders. */ sql<number>`COALESCE(json_extract(${event}, ${`$.message.details.${SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY}`}), 0) = 1 OR EXISTS (
    SELECT 1 FROM json_each(${event}, '$.message.content') WHERE type = 'object'
    AND ${contentPropertySql(event, "type")} = 'text' AND ${contentPropertySql(event, "text")} = ${LEGACY_MISSING_TOOL_RESULT_TEXT})`;
  return /* kysely-allow-raw: retain readable empty bodies only for navigation outside the model window. */ sql<string>`CASE ${entryType}
    WHEN 'message' THEN json_set(${entry}, '$.message', json_set(${messageFacts},
      '$.content', json(${calls}), '$.command', '', '$.output', '',
      '$.providerReplay', json_object('type', json_extract(${event}, '$.message.providerReplay.type')),
      '$.details', json_patch(json_object(${SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY}, json(CASE WHEN (${synthetic}) THEN 'true' ELSE 'false' END)),
        CASE WHEN ${messageOperatorKind} IS NULL THEN json('{}') ELSE json_object('kind', ${messageOperatorKind}) END)))
    WHEN 'custom_message' THEN CASE WHEN ${entryOperatorKind} IS NULL THEN ${customMessage}
      ELSE json_set(${customMessage}, '$.details', json_object('kind', ${entryOperatorKind})) END
    WHEN 'custom' THEN CASE WHEN ${jsonPathValue(db, event, sql.lit("$.customType"))} = 'openclaw.system-prompt'
      THEN json_set(${entry}, '$.data', json_object('restart', json(CASE
        WHEN json_type(${event}, '$.data.restart') = 'true' THEN 'true' ELSE 'false' END)))
      ELSE ${entry} END
    WHEN 'compaction' THEN json_set(${entry}, '$.summary', '')
    WHEN 'branch_summary' THEN json_set(${entry}, '$.summary', '')
    ELSE ${entry} END`;
}

function postgresModelNavigationSql(
  db: DatabaseSync,
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
