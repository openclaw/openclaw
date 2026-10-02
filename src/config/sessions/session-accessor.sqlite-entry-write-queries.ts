import type { DatabaseSync } from "node:sqlite";
import { prepareSqliteQuerySync } from "../../infra/kysely-sync.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import type { bindSessionNode, bindSessionRoot } from "./session-accessor.sqlite-session-row.js";

type SessionWindowWriteRow = Omit<ReturnType<typeof bindSessionRoot>, "primary_conversation_id"> & {
  primary_conversation_id: string | null;
  transcript_observed_at: number;
};

function prepareSessionEntryWriteQueries(database: DatabaseSync) {
  const db = getSessionKysely(database);
  const window = (retainOwner: boolean) =>
    prepareSqliteQuerySync<SessionWindowWriteRow>(database, (parameter) =>
      db
        .insertInto("session_windows")
        .values({
          session_id: parameter((row) => row.session_id),
          session_key: parameter((row) => row.session_key),
          reason: parameter((row) => row.reason),
          created_at: parameter((row) => row.created_at),
          updated_at: parameter((row) => row.updated_at),
          session_entry_provenance: parameter((row) => row.session_entry_provenance),
          acp_owned: parameter((row) => row.acp_owned),
          plugin_owner_id: parameter((row) => row.plugin_owner_id),
          hook_external_content_source: parameter((row) => row.hook_external_content_source),
          previous_session_id: parameter((row) => row.previous_session_id),
          session_scope: parameter((row) => row.session_scope),
          started_at: parameter((row) => row.started_at),
          ended_at: parameter((row) => row.ended_at),
          status: parameter((row) => row.status),
          chat_type: parameter((row) => row.chat_type),
          channel: parameter((row) => row.channel),
          account_id: parameter((row) => row.account_id),
          model_provider: parameter((row) => row.model_provider),
          model: parameter((row) => row.model),
          agent_harness_id: parameter((row) => row.agent_harness_id),
          parent_session_key: parameter((row) => row.parent_session_key),
          spawned_by: parameter((row) => row.spawned_by),
          display_name: parameter((row) => row.display_name),
          primary_conversation_id: parameter((row) => row.primary_conversation_id),
          transcript_observed_at: parameter((row) => row.transcript_observed_at),
        })
        .onConflict((conflict) =>
          conflict.column("session_id").doUpdateSet((eb) => ({
            // Logical nodes can share a physical window. Only creation or a
            // generation change claims it; metadata updates retain its owner.
            ...(retainOwner ? {} : { session_key: eb.ref("excluded.session_key") }),
            previous_session_id: eb.ref("excluded.previous_session_id"),
            reason: eb.ref("excluded.reason"),
            session_scope: eb.ref("excluded.session_scope"),
            transcript_observed_at: eb.ref("excluded.transcript_observed_at"),
            session_entry_provenance: eb.ref("excluded.session_entry_provenance"),
            acp_owned: eb.ref("excluded.acp_owned"),
            plugin_owner_id: eb.ref("excluded.plugin_owner_id"),
            hook_external_content_source: eb.ref("excluded.hook_external_content_source"),
            updated_at: eb.ref("excluded.updated_at"),
            started_at: eb.ref("excluded.started_at"),
            ended_at: eb.ref("excluded.ended_at"),
            status: eb.ref("excluded.status"),
            chat_type: eb.ref("excluded.chat_type"),
            channel: eb.ref("excluded.channel"),
            account_id: eb.ref("excluded.account_id"),
            primary_conversation_id: eb.ref("excluded.primary_conversation_id"),
            model_provider: eb.ref("excluded.model_provider"),
            model: eb.ref("excluded.model"),
            agent_harness_id: eb.ref("excluded.agent_harness_id"),
            parent_session_key: eb.ref("excluded.parent_session_key"),
            spawned_by: eb.ref("excluded.spawned_by"),
            display_name: eb.ref("excluded.display_name"),
          })),
        ),
    );
  return {
    node: prepareSqliteQuerySync<ReturnType<typeof bindSessionNode>>(database, (parameter) =>
      db
        .insertInto("session_nodes")
        .values({
          session_key: parameter((row) => row.session_key),
          current_session_id: parameter((row) => row.current_session_id),
          entry_json: parameter((row) => row.entry_json),
          entry_valid: parameter((row) => row.entry_valid),
          updated_at: parameter((row) => row.updated_at),
          status: parameter((row) => row.status),
          created_at: parameter((row) => row.created_at),
          created_via: parameter((row) => row.created_via),
          created_actor_type: parameter((row) => row.created_actor_type),
          created_actor_id: parameter((row) => row.created_actor_id),
          project_id: parameter((row) => row.project_id),
          parent_session_key: parameter((row) => row.parent_session_key),
          spawned_by: parameter((row) => row.spawned_by),
          fork_source_session_key: parameter((row) => row.fork_source_session_key),
          fork_source_session_id: parameter((row) => row.fork_source_session_id),
          fork_source_entry_id: parameter((row) => row.fork_source_entry_id),
          label: parameter((row) => row.label),
          display_name: parameter((row) => row.display_name),
          category: parameter((row) => row.category),
          icon: parameter((row) => row.icon),
          pinned_at: parameter((row) => row.pinned_at),
          archived_at: parameter((row) => row.archived_at),
          last_read_at: parameter((row) => row.last_read_at),
          last_interaction_at: parameter((row) => row.last_interaction_at),
          last_activity_at: parameter((row) => row.last_activity_at),
        })
        .onConflict((conflict) =>
          conflict.column("session_key").doUpdateSet((eb) => ({
            current_session_id: eb.ref("excluded.current_session_id"),
            entry_json: eb.ref("excluded.entry_json"),
            entry_valid: eb.ref("excluded.entry_valid"),
            updated_at: eb.ref("excluded.updated_at"),
            status: eb.ref("excluded.status"),
            created_at: eb.ref("excluded.created_at"),
            created_via: eb.ref("excluded.created_via"),
            created_actor_type: eb.ref("excluded.created_actor_type"),
            created_actor_id: eb.ref("excluded.created_actor_id"),
            project_id: eb.ref("excluded.project_id"),
            parent_session_key: eb.ref("excluded.parent_session_key"),
            spawned_by: eb.ref("excluded.spawned_by"),
            fork_source_session_key: eb.ref("excluded.fork_source_session_key"),
            fork_source_session_id: eb.ref("excluded.fork_source_session_id"),
            fork_source_entry_id: eb.ref("excluded.fork_source_entry_id"),
            label: eb.ref("excluded.label"),
            display_name: eb.ref("excluded.display_name"),
            category: eb.ref("excluded.category"),
            icon: eb.ref("excluded.icon"),
            pinned_at: eb.ref("excluded.pinned_at"),
            archived_at: eb.ref("excluded.archived_at"),
            last_read_at: eb.ref("excluded.last_read_at"),
            last_interaction_at: eb.ref("excluded.last_interaction_at"),
            last_activity_at: eb.ref("excluded.last_activity_at"),
          })),
        ),
    ),
    markValid: prepareSqliteQuerySync<string>(database, (parameter) =>
      db
        .updateTable("session_nodes")
        .set({ entry_valid: 1 })
        .where(
          "session_key",
          "=",
          parameter((key) => key),
        ),
    ),
    claimWindow: window(false),
    retainWindow: window(true),
  };
}

// Cache fixed SQL shapes only; every write binds fresh rows through the normal executor.
const sessionEntryWriteQueries = new WeakMap<
  DatabaseSync,
  ReturnType<typeof prepareSessionEntryWriteQueries>
>();

export function getSessionEntryWriteQueries(database: DatabaseSync) {
  let queries = sessionEntryWriteQueries.get(database);
  if (!queries) {
    queries = prepareSessionEntryWriteQueries(database);
    sessionEntryWriteQueries.set(database, queries);
  }
  return queries;
}
