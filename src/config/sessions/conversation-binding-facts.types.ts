import type { Selectable } from "kysely";
import type { SqliteCommitSource } from "../../infra/sqlite-commit-receipt.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";

export type ConversationBindingNode = Pick<
  Selectable<DB["session_nodes"]>,
  "session_key" | "current_session_id" | "entry_valid" | "updated_at"
> & { entry_session_id: string | null };

export type ConversationBindingWindow = Pick<
  Selectable<DB["session_windows"]>,
  "session_id" | "session_key" | "primary_conversation_id"
>;

export type ConversationBindingSnapshot = {
  source?: SqliteCommitSource;
  catalogues: { conversation_id: string; kind: string }[];
  associations: {
    session_id: string;
    conversation_id: string;
    role: string;
    last_seen_at: number;
  }[];
  windows: ConversationBindingWindow[];
  nodes: ConversationBindingNode[];
};

export type ConversationBindingsWorkerInput = {
  kind: "conversation-bindings";
  database: { agentId: string; path: string };
  conversationRefs: readonly string[];
  env: NodeJS.ProcessEnv;
};
