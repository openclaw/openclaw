import { sql, type Expression, type RawBuilder } from "kysely";
import {
  DEFAULT_MISSING_TOOL_RESULT_TEXT,
  SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY,
} from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import { supportsNodeSqliteJsonb } from "../../infra/node-sqlite.js";
import { MODEL_CONTEXT_PRIVATE_METADATA_KEYS } from "../../shared/model-context-message.js";

/** Exclude storage-only fields in SQLite, before a row's JSON crosses into JavaScript. */
export function projectModelContextEventSql(
  event: Expression<string | Uint8Array>,
  omitCheckpoint: Expression<number>,
  toolResultOmission?: Expression<string | null>,
): RawBuilder<string> {
  const paths = MODEL_CONTEXT_PRIVATE_METADATA_KEYS.map((key) => `$.message.__openclaw.${key}`);
  const projected = /* kysely-allow-raw: query-time JSON projection preserves durable transcript bytes. */ sql<string>`json_remove(${event}, ${sql.join(paths)})`;
  const modelEvent = /* kysely-allow-raw: tool result details are not model input; other details can be runtime context. */ sql<string>`CASE WHEN json_extract(${event}, '$.message.role') = 'toolResult'
    THEN json_remove(${projected}, '$.message.details') ELSE ${projected} END`;
  const boundedEvent = toolResultOmission
    ? /* kysely-allow-raw: omit only selected result bodies before hydration; durable rows remain unchanged. */ sql<string>`CASE WHEN ${toolResultOmission} IS NOT NULL AND json_extract(${event}, '$.message.role') = 'toolResult'
      THEN json_set(${modelEvent}, '$.message.content', json_array(json_object('type', 'text', 'text', ${toolResultOmission}))) ELSE ${modelEvent} END`
    : modelEvent;
  // The context owner classifies invalidated prefix checkpoints using the transport
  // contract. Other replay state must survive, including checkpoints after the cut.
  return /* kysely-allow-raw: exclude invalidated replay before hydrating a retained prefix. */ sql<string>`CASE WHEN ${omitCheckpoint} = 1
    THEN json_remove(${boundedEvent}, '$.message.providerReplay') ELSE ${boundedEvent} END`;
}

function pickJsonObject(value: Expression<unknown>, keys: readonly string[]): RawBuilder<string> {
  // json_each distinguishes absent properties from explicit nulls. Preserve JSON
  // subtypes so booleans and nested navigation facts do not become strings/numbers.
  return /* kysely-allow-raw: narrow JSON member selection, with bound property names. */ sql<string>`(SELECT json_group_object(key, CASE type
    WHEN 'object' THEN json(value) WHEN 'array' THEN json(value)
    WHEN 'true' THEN json('true') WHEN 'false' THEN json('false')
    ELSE value END) FROM json_each(${value}) WHERE key IN (${sql.join(keys)}))`;
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

const TRANSCRIPT_NAVIGATION_KEYS = [
  "type",
  "id",
  "parentId",
  "targetId",
  "appendParentId",
  "appendMode",
] as const;

const MODEL_CONTEXT_NAVIGATION_KEYS = [
  ...TRANSCRIPT_NAVIGATION_KEYS,
  "timestamp",
  "version",
  "cwd",
  "firstKeptEntryId",
  "reason",
  "tokensBefore",
  "thinkingLevel",
  "provider",
  "modelId",
  "fromId",
  "customType",
  "display",
  "label",
  "name",
] as const;

type JsonMemberAlias = "root_member" | "message_member" | "archive_internal" | "archive_details";

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
  event: Expression<string | Uint8Array>,
  options: { archive?: boolean } = {},
): RawBuilder<string> {
  if (options.archive) {
    return projectArchiveTranscriptNavigationSql(event);
  }
  const memberValue =
    /* kysely-allow-raw: fixed JSON member cursor declared in the message projection below. */ sql.ref(
      "message_member.value",
    );
  const internal = pickJsonObject(memberValue, ["runId", "steerTargetRunId", "contextFreeCommand"]);
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

/** Large identity rows use the payload owner's conservative native eligibility; callers require UTF-8 storage. */
export function projectSupportedTranscriptPayloadNavigationSql(
  event: Expression<string>,
  maxBytes: number,
): RawBuilder<string | null> {
  const projection = projectTranscriptPayloadNavigationSql(event, { archive: true });
  return /* kysely-allow-raw: strict JSON and Unicode admission precede native traversal; metadata is capped before JS hydration. */ sql<
    string | null
  >`(
    WITH native_navigation AS MATERIALIZED (
      SELECT CASE WHEN json_valid(${event}) THEN CASE
        WHEN instr(${event}, ${"\\u"}) = 0 AND instr(${event}, char(0)) = 0 AND json_type(${event}) = 'object'
          THEN ${projection} END END AS value
    )
    SELECT CASE WHEN octet_length(value) <= ${maxBytes} THEN value END FROM native_navigation
  )`;
}

function lastArchiveMemberIds(
  value: Expression<unknown>,
  keys?: readonly string[],
): RawBuilder<unknown> {
  return /* kysely-allow-raw: duplicate selection sorts only decoded keys and native IDs, never payload values. */ sql`(
    SELECT max(id) FROM json_each(${value})
    ${keys ? sql`WHERE key IN (${sql.join(keys)})` : sql``}
    GROUP BY key
  )`;
}

function lastArchiveObjectMembers(
  value: Expression<unknown>,
  alias: JsonMemberAlias,
  projected: Expression<unknown> = jsonMemberValue(alias),
  keys?: readonly string[],
): RawBuilder<string> {
  const member =
    /* kysely-allow-raw: private JsonMemberAlias union contains only fixed JSON cursor names. */ sql.ref(
      alias,
    );
  return /* kysely-allow-raw: fixed archive envelope members retain JSON.parse's last duplicate key without hydrating discarded values. */ sql<string>`(
    SELECT json_group_object(${/* kysely-allow-raw: fixed key column on the private JsonMemberAlias union. */ sql.ref(`${alias}.key`)}, ${projected})
    FROM json_each(${value}) AS ${member}
    WHERE ${/* kysely-allow-raw: fixed id column on the private JsonMemberAlias union. */ sql.ref(`${alias}.id`)} IN ${lastArchiveMemberIds(value, keys)}
  )`;
}

function projectArchiveTranscriptNavigationSql(
  event: Expression<string | Uint8Array>,
): RawBuilder<string> {
  const internal = lastArchiveObjectMembers(
    /* kysely-allow-raw: fixed JSON cursor value declared by this projection. */ sql.ref(
      "message_member.value",
    ),
    "archive_internal",
    undefined,
    ["runId", "steerTargetRunId", "contextFreeCommand", "idempotencyKey"],
  );
  const message = lastArchiveObjectMembers(
    /* kysely-allow-raw: fixed JSON cursor value declared by this projection. */ sql.ref(
      "root_member.value",
    ),
    "message_member",
    sql`CASE WHEN message_member.key = '__openclaw' AND message_member.type = 'object'
      THEN json(${internal}) ELSE ${jsonMemberValue("message_member")} END`,
    ["role", "display", "idempotencyKey", "provenance", "excludeFromContext", "__openclaw"],
  );
  const details = lastArchiveObjectMembers(
    /* kysely-allow-raw: fixed JSON cursor value declared by this projection. */ sql.ref(
      "root_member.value",
    ),
    "archive_details",
    undefined,
    ["runId"],
  );
  return lastArchiveObjectMembers(
    event,
    "root_member",
    sql`CASE WHEN root_member.key = 'message' AND root_member.type = 'object'
      THEN json(${message})
      WHEN root_member.key = 'details' AND root_member.type = 'object'
      THEN json(${details}) ELSE ${jsonMemberValue("root_member")} END`,
    [...MODEL_CONTEXT_NAVIGATION_KEYS, "message", "role", "details"],
  );
}

/** Cursor resolution needs only tree facts, even when a row has an opaque body. */
export function projectTranscriptNavigationSql(event: Expression<string>): RawBuilder<string> {
  return pickJsonObject(event, TRANSCRIPT_NAVIGATION_KEYS);
}

/** Reset boundaries select ancestry and replay roles without loading message bodies. */
export function projectResetBoundaryNavigationSql(event: Expression<string>): RawBuilder<string> {
  const entry = pickJsonObject(event, [
    ...TRANSCRIPT_NAVIGATION_KEYS,
    "timestamp",
    "firstKeptEntryId",
    "customType",
    "display",
  ]);
  // Non-object rows keep their parser behavior; malformed and SQLite-overdepth JSON
  // must reach JSON.parse unchanged instead of failing inside the metadata projection.
  return /* kysely-allow-raw: reset planning uses navigation metadata, never durable transcript payloads. */ sql<string>`CASE WHEN json_valid(${event}) THEN
    CASE WHEN json_type(${event}) = 'object' THEN
      json_set(${entry}, '$.message', json_object('role', json_extract(${event}, '$.message.role')))
    ELSE ${event} END
    ELSE ${event} END`;
}

/** Lightweight tree/state records; these never serve as persisted transcript evidence. */
export function projectModelContextNavigationSql(
  event: Expression<string | Uint8Array>,
): RawBuilder<string> {
  const entry = pickJsonObject(event, MODEL_CONTEXT_NAVIGATION_KEYS);
  // Binary intermediates avoid serializing and reparsing the entire message.
  const message = supportsNodeSqliteJsonb()
    ? /* kysely-allow-raw: JSONB remains inside SQLite; durable transcript bytes stay text. */ sql`jsonb_extract(${event}, '$.message')`
    : /* kysely-allow-raw: supported SQLite 3.44 libraries retain text JSON extraction. */ sql`json_extract(${event}, '$.message')`;
  const messageFacts = pickJsonObject(message, [
    "role",
    "provider",
    "model",
    "timestamp",
    "excludeFromContext",
    "toolCallId",
    "toolUseId",
    "tool_call_id",
    "tool_use_id",
    "callId",
    "call_id",
    "toolName",
    "isError",
    "stopReason",
    "customType",
    "display",
  ]);
  const calls = /* kysely-allow-raw: pairing needs call identities, never tool arguments or result bodies. */ sql<string>`(SELECT json_group_array(json_object(
    'type', ${contentPropertySql(event, "type")}, 'id', ${contentPropertySql(event, "id")},
    'name', ${contentPropertySql(event, "name")}))
    FROM json_each(${event}, '$.message.content') WHERE type = 'object'
    AND ${contentPropertySql(event, "type")} IN ('toolCall', 'toolUse', 'functionCall'))`;
  const synthetic = /* kysely-allow-raw: pairing prefers real results over synthetic missing-result placeholders. */ sql<number>`COALESCE(json_extract(${event}, ${`$.message.details.${SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY}`}), 0) = 1 OR EXISTS (
    SELECT 1 FROM json_each(${event}, '$.message.content') WHERE type = 'object'
    AND ${contentPropertySql(event, "type")} = 'text' AND ${contentPropertySql(event, "text")} = ${DEFAULT_MISSING_TOOL_RESULT_TEXT})`;
  return /* kysely-allow-raw: retain readable empty bodies only for navigation outside the model window. */ sql<string>`CASE json_extract(${event}, '$.type')
    WHEN 'message' THEN json_set(${entry}, '$.message', json_set(${messageFacts},
      '$.content', json(${calls}), '$.command', '', '$.output', '',
      '$.providerReplay', json_object('type', json_extract(${event}, '$.message.providerReplay.type')),
      '$.details', json_object(${SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY}, json(CASE WHEN (${synthetic}) THEN 'true' ELSE 'false' END))))
    WHEN 'custom_message' THEN json_set(${entry}, '$.content', json('[]'))
    WHEN 'compaction' THEN json_set(${entry}, '$.summary', '')
    WHEN 'branch_summary' THEN json_set(${entry}, '$.summary', '')
    ELSE ${entry} END`;
}
