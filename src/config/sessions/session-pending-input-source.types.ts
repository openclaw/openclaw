import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import type {
  PendingInputSourceRead,
  PendingInputSourceSnapshot,
} from "./session-pending-input-operations.types.js";

export type Input = {
  kind: "session-pending-input-source";
  database: { agentId: string; path: string };
  env: NodeJS.ProcessEnv;
  input: PendingInputSourceRead;
  source: CapturedSessionEntryReadSource;
};
export type Value = { kind: "session-pending-input-source"; snapshot: PendingInputSourceSnapshot };
export type Reader = (
  input: Omit<Input, "kind" | "database">,
) => Promise<PendingInputSourceSnapshot>;
