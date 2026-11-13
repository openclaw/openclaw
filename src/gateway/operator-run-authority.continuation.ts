import {
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import { runOutsideReleasedPluginInvocationScope } from "../plugins/plugin-instance-scope.js";

/** Only an accepting continuation may leave its released producer's invocation scope. */
export function bindIndependentContinuationAuthority(source: AdmittedRunOperatorAuthority) {
  const retain = source.retain;
  const readRoleFacts = source.readCurrentRoleFacts;
  return createAdmittedRunOperatorAuthority({
    ...source,
    assertCurrent: composeSessionSourceAssertion(
      [source.assertCurrent],
      runOutsideReleasedPluginInvocationScope,
    ),
    retain: retain ? () => runOutsideReleasedPluginInvocationScope(retain) : undefined,
    readCurrentRoleFacts: readRoleFacts
      ? () => runOutsideReleasedPluginInvocationScope(readRoleFacts)
      : undefined,
    get modelPolicy() {
      return source.modelPolicy;
    },
  });
}
