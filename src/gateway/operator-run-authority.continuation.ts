import {
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import { runOutsideReleasedPluginInvocationScope } from "../plugins/plugin-instance-scope.js";

const independentContinuationAuthorities = new WeakSet<AdmittedRunOperatorAuthority>();

/** Only an accepting continuation may leave its released producer's invocation scope. */
export function bindIndependentContinuationAuthority(source: AdmittedRunOperatorAuthority) {
  if (independentContinuationAuthorities.has(source)) {
    return source;
  }
  const retain = source.retain;
  const readRoleFacts = source.readCurrentRoleFacts;
  const authority = createAdmittedRunOperatorAuthority({
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
  independentContinuationAuthorities.add(authority);
  return authority;
}
