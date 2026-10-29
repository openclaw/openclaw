import type { SessionEntryCommitContext } from "../../config/sessions/session-accessor.types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { ensureSessionGroupRegistered } from "../session-groups.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { sessionLog } from "./sessions-shared.js";

/** Registration is bookkeeping for a witnessed session commit, not permission to retry it. */
export async function registerCommittedSessionCategory(
  category: string | undefined,
  context: Parameters<typeof emitSessionsChanged>[0],
  source: SessionEntryCommitContext,
): Promise<void> {
  if (!category?.trim()) {
    return;
  }
  let changed: boolean;
  try {
    source.assertCurrent();
    changed = await ensureSessionGroupRegistered(category, source.env, source.assertCurrent);
    source.assertCurrent();
  } catch (error) {
    sessionLog.warn(
      `session category ${JSON.stringify(category)} was saved, but group registration failed; retry the same category assignment to repair the catalog: ${formatErrorMessage(error)}`,
    );
    // A failed receipt or cleanup can follow COMMIT. Reload only the catalog.
    changed = true;
  }
  if (changed) {
    emitSessionsChanged(context, { reason: "groups" }, { catalogOnly: true });
  }
}
