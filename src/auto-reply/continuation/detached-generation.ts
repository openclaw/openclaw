// Continuation (karmaterminal): a detached continuation re-entry (timer, retry, retained operator
// scope) admits on the plugin generation and turn current when it runs, never the arming turn's.
// Upstream's helper drops the inherited generation scopes and workspace gate; the prepared reply
// dispatch runtime pins the arming request's generation too (get-reply-run acquires on it), so it
// goes with them.
import { bindPreparedReplyDispatchRuntime } from "../reply/prepared-reply-dispatch-context.js";
import { runOutsideAdmittedTurnScopes } from "../reply/queue/drain-admission-scope.js";

export function runOnCurrentPluginGeneration<T>(run: () => Promise<T>): Promise<T> {
  return runOutsideAdmittedTurnScopes(bindPreparedReplyDispatchRuntime(undefined, run));
}
