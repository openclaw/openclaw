import { resolveGlobalSingleton } from "../shared/global-singleton.js";

/** Original policy, configuration and person/grant inputs captured by the access owner. */
export type OperatorAccessDecision = Readonly<{
  policy: object;
  config: object;
  subject: string;
}>;

const decisions = resolveGlobalSingleton(
  Symbol.for("openclaw.operatorAccessDecision"),
  (): { current?: { decision: OperatorAccessDecision; scope: unknown; call: unknown }[] } => ({}),
);

/** Nested lineage shares one synchronous effect check, never a later call or await. */
export function scopeOperatorAccessDecisions<T>(check: (input: T) => void): (input: T) => void {
  return (input) => {
    if (decisions.current) {
      return check(input);
    }
    decisions.current = [];
    try {
      check(input);
    } finally {
      decisions.current = undefined;
    }
  };
}

/** The caller still checks every captured source's native signal and person identity. */
export function assertOperatorAccessDecision(
  decision: OperatorAccessDecision | undefined,
  assertCurrent: () => void,
  scope: unknown,
  call: unknown,
): void {
  const current = decisions.current;
  if (
    decision &&
    current?.some(
      (accepted) =>
        accepted.decision.policy === decision.policy &&
        accepted.decision.config === decision.config &&
        accepted.decision.subject === decision.subject &&
        accepted.scope === scope &&
        accepted.call === call,
    )
  ) {
    return;
  }
  assertCurrent();
  if (decision && current) {
    current.push({ decision, scope, call });
  }
}
