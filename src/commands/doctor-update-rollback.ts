/** Emits the persistent post-update rollback result before Doctor performs repairs. */
import { note } from "../../packages/terminal-core/src/note.js";
import {
  formatUpdateRollbackNarration,
  readUpdateRollbackTransaction,
} from "../infra/update-rollback.js";

export async function noteUpdateRollbackStatus(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const narration = formatUpdateRollbackNarration(
    await readUpdateRollbackTransaction(env).catch(() => null),
  );
  if (narration) {
    note(narration, "Update rollback");
  }
}
