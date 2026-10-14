type ConfigWriteAssertion = () => void;
type AssertionRun = (checked: Set<ConfigWriteAssertion>) => void;

// Provenance only; successful observations belong to one synchronous invocation.
const composedAssertions = new WeakMap<ConfigWriteAssertion, AssertionRun>();

function runAssertion(assertion: ConfigWriteAssertion, checked: Set<ConfigWriteAssertion>): void {
  const composed = composedAssertions.get(assertion);
  if (composed) {
    // A retained guard must still expose a refusal latched after an earlier observation.
    composed(checked);
    return;
  }
  if (!checked.has(assertion)) {
    assertion();
    checked.add(assertion);
  }
}

/** Compose live checks in order, sharing identical leaves only within this call. */
export function composeConfigWriteAssertions(
  ...assertions: Array<ConfigWriteAssertion | undefined>
): ConfigWriteAssertion {
  const run: AssertionRun = (checked) => {
    for (const assertion of assertions) {
      if (assertion) {
        runAssertion(assertion, checked);
      }
    }
  };
  const assertion = () => run(new Set());
  composedAssertions.set(assertion, run);
  return assertion;
}

/** Keep a refused operation terminal, even when another composition retained this guard. */
export function createConfigWriteAuthorityGuard(
  ...assertions: Array<ConfigWriteAssertion | undefined>
): ConfigWriteAssertion {
  const composed = composeConfigWriteAssertions(...assertions);
  let refusal: { error: unknown } | undefined;
  const run: AssertionRun = (checked) => {
    if (refusal) {
      throw refusal.error;
    }
    try {
      runAssertion(composed, checked);
    } catch (error) {
      refusal = { error };
      throw error;
    }
  };
  const guard = () => run(new Set());
  composedAssertions.set(guard, run);
  return guard;
}
