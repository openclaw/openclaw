import { sql, type Expression, type RawBuilder } from "kysely";
import {
  LEGACY_MISSING_TOOL_RESULT_TEXT,
  SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY,
} from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import {
  jsonArrayValue,
  jsonObjectValue,
  jsonPathValue,
  jsonPickObject,
  jsonRemovePaths,
  jsonSetPath,
  jsonType,
  jsonValid,
} from "../../infra/database-engine/json-values.js";
import { supportsNodeSqliteJsonb } from "../../infra/node-sqlite.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import { MODEL_CONTEXT_PRIVATE_METADATA_KEYS } from "../../shared/model-context-message.js";
import {
  MODEL_CONTEXT_NAVIGATION_KEYS,
  MODEL_MESSAGE_NAVIGATION_KEYS,
  TRANSCRIPT_NAVIGATION_KEYS,
} from "./session-model-context-navigation.js";

/** Exclude storage-only fields in SQLite, before a row's JSON crosses into JavaScript. */
export function projectModelContextEventSql(
  db: EngineConnection,
  event: Expression<string | Uint8Array>,
  omitCheckpoint: Expression<number>,
  toolResultOmission?: Expression<string | null>,
  role: Expression<unknown> = jsonPathValue(db, event, sql.lit("$.message.role")),
): RawBuilder<string> {
  if (isPostgresSqlConnection(db)) {
    const model = postgresModelEventSql(event, role);
    const bounded = toolResultOmission
      ? /* kysely-allow-raw: Replace only an explicitly omitted tool body in native JSONB. */ sql`CASE WHEN ${toolResultOmission} IS NOT NULL AND ${role} = 'toolResult'
          THEN jsonb_set(${model}, '{message,content}', jsonb_build_array(jsonb_build_object('type', 'text', 'text', ${toolResultOmission}::text)))
          ELSE ${model} END`
      : model;
    return /* kysely-allow-raw: Serialize once at the model payload boundary. */ sql<string>`(CASE WHEN ${omitCheckpoint} = 1
      THEN ${bounded} #- '{message,providerReplay}' ELSE ${bounded} END)::text`;
  }
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
  db: EngineConnection,
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
  db: EngineConnection,
  event: Expression<string>,
): RawBuilder<string> {
  return jsonPickObject(db, event, TRANSCRIPT_NAVIGATION_KEYS);
}

/** Reset boundaries select ancestry and replay roles without loading message bodies. */
export function projectResetBoundaryNavigationSql(
  db: EngineConnection,
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

/** Lightweight tree/state records; these never serve as persisted transcript evidence. */
export function projectModelContextNavigationSql(
  db: EngineConnection,
  event: Expression<string | Uint8Array>,
  entryType?: Expression<unknown>,
): RawBuilder<string> {
  if (isPostgresSqlConnection(db)) {
    const source =
      /* kysely-allow-raw: Fixed column in the materialized navigation input below. */ sql.ref<string>(
        "nav_parts.event",
      );
    const message =
      /* kysely-allow-raw: Fixed message column from the materialized input below. */ sql.ref(
        "nav_parts.message",
      );
    const content =
      /* kysely-allow-raw: Fixed content column from the materialized input below. */ sql.ref(
        "nav_parts.content",
      );
    const type =
      entryType ??
      /* kysely-allow-raw: Discriminant lookup from the once-parsed event. */ sql`${source} ->> 'type'`;
    return /* kysely-allow-raw: Parse the event once and keep navigation intermediates native. */ sql<string>`(
      WITH nav_input AS MATERIALIZED (SELECT ${event}::jsonb AS event),
      nav_parts AS MATERIALIZED (SELECT event, event -> 'message' AS message,
        event #> '{message,content}' AS content FROM nav_input)
      SELECT ${postgresModelNavigationSql(source, message, content, type)}::text FROM nav_parts)`;
  }
  const sqliteEntryType = entryType ?? jsonPathValue(db, event, sql.lit("$.type"));
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
  return /* kysely-allow-raw: retain readable empty bodies only for navigation outside the model window. */ sql<string>`CASE ${sqliteEntryType}
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

/** Project only the caller's bounded page; no write path uses this relation. */
export function projectPostgresModelContextRowsSql(
  rows: Expression<{ seq: number; event_json: string | null; navigation_json: string | null }>,
): RawBuilder<{
  seq: number;
  navigation_json: string;
  model_bytes: number;
  retained_bytes: number;
}> {
  const event =
    /* kysely-allow-raw: Fixed parsed-event column from this page projection. */ sql.ref<string>(
      "context_projected.event",
    );
  const message =
    /* kysely-allow-raw: Fixed message column derived once for the selected page. */ sql.ref<string>(
      "context_projected.message",
    );
  const content =
    /* kysely-allow-raw: Fixed content column derived once for the selected page. */ sql.ref<string>(
      "context_projected.content",
    );
  const type = /* kysely-allow-raw: Native lookup of the parsed entry discriminant. */ sql`${event} ->> 'type'`;
  const model = postgresModelEventSql(
    /* kysely-allow-raw: Fixed event column from the materialized page input. */ sql.ref(
      "context_parts.event",
    ),
    /* kysely-allow-raw: Native role lookup in the once-derived message. */ sql`context_parts.message ->> 'role'`,
  );
  return /* kysely-allow-raw: One bounded read shares parsed JSONB and native model bytes across its projections. */ sql`(
    WITH context_input AS MATERIALIZED (
      SELECT seq, CASE WHEN navigation_json IS NULL THEN event_json::jsonb END AS event,
        navigation_json::jsonb AS metadata FROM (${rows}) AS selected
    ), context_parts AS MATERIALIZED (
      SELECT *, event -> 'message' AS message, event #> '{message,content}' AS content FROM context_input
    ), context_projected AS MATERIALIZED (
      SELECT *, ${model} AS model FROM context_parts
    ) SELECT seq,
      CASE WHEN metadata IS NULL THEN ${postgresModelNavigationSql(event, message, content, type)}::text
        ELSE (metadata -> 'model')::text END AS navigation_json,
      CASE WHEN metadata IS NULL THEN octet_length(model::text)
        ELSE (metadata ->> 'modelBytes')::double precision END AS model_bytes,
      CASE WHEN metadata IS NULL THEN octet_length((model #- '{message,providerReplay}')::text)
        ELSE (metadata ->> 'modelWithoutCheckpointBytes')::double precision END AS retained_bytes
    FROM context_projected ORDER BY seq
  )`;
}

function postgresModelEventSql(event: Expression<unknown>, role: Expression<unknown>) {
  let projected = event;
  for (const key of MODEL_CONTEXT_PRIVATE_METADATA_KEYS) {
    projected = /* kysely-allow-raw: Closed private metadata paths retain the existing model projection. */ sql`(${projected}::jsonb #- ${sql.lit(`{message,__openclaw,${key}}`)}::text[])`;
  }
  return /* kysely-allow-raw: Keep the model payload binary until byte accounting or hydration. */ sql`CASE WHEN ${role} = 'toolResult'
    THEN ${projected} #- '{message,details}' ELSE ${projected} END`;
}

function postgresNavigationObjectSql(event: Expression<unknown>, keys: readonly string[]) {
  return /* kysely-allow-raw: Closed navigation keys preserve missing versus explicit null values. */ sql`(
    SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
    FROM jsonb_each(CASE WHEN jsonb_typeof(${event}) = 'object' THEN ${event} ELSE '{}'::jsonb END)
    WHERE key IN (${sql.join(keys.map((key) => sql.lit(key)))})
  )`;
}

function postgresModelNavigationSql(
  event: Expression<unknown>,
  message: Expression<unknown>,
  content: Expression<unknown>,
  entryType: Expression<unknown>,
): RawBuilder<string> {
  const entry = postgresNavigationObjectSql(event, MODEL_CONTEXT_NAVIGATION_KEYS);
  const messageFacts = postgresNavigationObjectSql(message, MODEL_MESSAGE_NAVIGATION_KEYS);
  const elements = /* kysely-allow-raw: Only array content contributes tool identities and legacy markers. */ sql`jsonb_array_elements(
    CASE WHEN jsonb_typeof(${content}) = 'array' THEN ${content} ELSE '[]'::jsonb END)`;
  const calls = /* kysely-allow-raw: Preserve content order and legacy text-valued call identifiers. */ sql`(
    SELECT coalesce(jsonb_agg(jsonb_build_object('type', value ->> 'type', 'id', value ->> 'id', 'name', value ->> 'name')), '[]'::jsonb)
    FROM ${elements} WHERE jsonb_typeof(value) = 'object' AND value ->> 'type' IN ('toolCall', 'toolUse', 'functionCall'))`;
  const synthetic = /* kysely-allow-raw: The textual marker comparison preserves numeric-scale behavior. */ sql`coalesce((${message} #> ${sql.lit(`{details,${SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY}}`)}::text[])::text, 'false') IN ('true', '1') OR EXISTS (
    SELECT 1 FROM ${elements} WHERE value ->> 'type' = 'text' AND value ->> 'text' = ${LEGACY_MISSING_TOOL_RESULT_TEXT})`;
  const kind = /* kysely-allow-raw: Only the existing two system-update kinds enter navigation. */ sql`CASE WHEN ${message} ->> 'customType' = 'openclaw.system-update'
    AND ${message} #>> '{details,kind}' IN ('prompt-update', 'runtime-context') THEN ${message} #>> '{details,kind}' END`;
  const customKind = /* kysely-allow-raw: Root custom messages use the same bounded operator kinds. */ sql`CASE WHEN ${event} ->> 'customType' = 'openclaw.system-update'
    AND ${event} #>> '{details,kind}' IN ('prompt-update', 'runtime-context') THEN ${event} #>> '{details,kind}' END`;
  return /* kysely-allow-raw: Build each navigation object once, merging only projected fields. */ sql<string>`CASE ${entryType}
    WHEN 'message' THEN ${entry} || jsonb_build_object('message', ${messageFacts} || jsonb_build_object(
      'content', ${calls}, 'command', '', 'output', '',
      'providerReplay', jsonb_build_object('type', ${message} #>> '{providerReplay,type}'),
      'details', jsonb_build_object(${sql.lit(SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY)}, (${synthetic})) ||
        CASE WHEN ${kind} IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('kind', ${kind}) END))
    WHEN 'custom_message' THEN ${entry} || jsonb_build_object('content', '[]'::jsonb) ||
      CASE WHEN ${customKind} IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('details', jsonb_build_object('kind', ${customKind})) END
    WHEN 'custom' THEN CASE WHEN ${event} ->> 'customType' = 'openclaw.system-prompt'
      THEN ${entry} || jsonb_build_object('data', jsonb_build_object('restart', coalesce((${event} #> '{data,restart}')::text, 'false') = 'true'))
      ELSE ${entry} END
    WHEN 'compaction' THEN ${entry} || jsonb_build_object('summary', '')
    WHEN 'branch_summary' THEN ${entry} || jsonb_build_object('summary', '')
    ELSE ${entry} END`;
}
