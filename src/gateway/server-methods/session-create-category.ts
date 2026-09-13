import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { formatErrorMessage } from "../../infra/errors.js";
import { ensureSessionGroupRegistered } from "../session-groups.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { sessionLog } from "./sessions-shared.js";

export function registerCreatedSessionCategory(
  request: { category?: string; inheritParentGroup?: boolean },
  createdCategory: string | undefined,
  context: Parameters<typeof emitSessionsChanged>[0],
): void {
  const category = normalizeOptionalString(
    request.category === undefined && request.inheritParentGroup === true
      ? createdCategory
      : request.category,
  );
  if (!category) {
    return;
  }
  try {
    if (ensureSessionGroupRegistered(category)) {
      // Catalog bookkeeping follows the authoritative session commit and has
      // its own invalidation. Its failure must not make a durable create ambiguous.
      emitSessionsChanged(context, { reason: "groups" });
    }
  } catch (error) {
    sessionLog.warn(`failed to register created session category: ${formatErrorMessage(error)}`);
  }
}
