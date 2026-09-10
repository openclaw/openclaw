import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import { catalogRegistrationSnapshot } from "./session-catalog-provider-access.js";

/** An ambiguous provider claim is not authority to read either provider's history. */
export function resolveTaskHistoryProvider(task: TaskRecord): SessionCatalogProvider | undefined {
  if (task.childSessionKey || !task.taskKind || !task.requesterSessionKey) {
    return undefined;
  }
  const taskKind = task.taskKind;
  const candidates = catalogRegistrationSnapshot().providers.filter((provider) =>
    provider.taskHistory?.taskKinds.includes(taskKind),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}
