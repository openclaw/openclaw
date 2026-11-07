import { retainSessionEntryWorkerPublication } from "./session-accessor.sqlite-entry-worker-publication.js";
import type { PreparedSessionSourceAuthority } from "./session-source-authority.js";
import { captureSessionSourceEffectAssertion } from "./session-source-effects.js";
/** Initialization retains the same actual admission for its final-grant and commit publisher. */
export function captureSessionSourceEntryPublication(
  options: { agentId: string; path: string },
  databaseIdentity: string,
  assertCurrent: () => void,
) {
  const assertion = captureSessionSourceEffectAssertion(assertCurrent);
  return {
    assertCurrent: assertion,
    publication: retainSessionEntryWorkerPublication({
      agentId: options.agentId,
      storePath: options.path,
      databaseIdentity,
      sourceAssertion: assertion,
    }),
  };
}

/** Native kernels can compare prepared predicates only for their own physical source. */
export function bindSessionSourceInput<T extends object>(
  input: T,
  source: Pick<PreparedSessionSourceAuthority, "checks">,
  databaseIdentity: string,
) {
  return source.checks.every(
    ({ predicate }) => predicate.source.databaseIdentity === databaseIdentity,
  )
    ? { ...input, sources: source.checks.map(({ predicate }) => predicate) }
    : input;
}
