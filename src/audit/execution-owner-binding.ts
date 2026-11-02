import {
  resolveAdmittedRunActiveAssertion,
  type AdmittedRunContext,
  type PreparedAgentRunAdmission,
} from "../agents/admitted-run-context.js";

/** Adds one exact owner write after admission resolves, never inside the admission callback. */
export function withPostAdmissionExecutionOwnerBinding(
  prepared: PreparedAgentRunAdmission,
  bind: (context: AdmittedRunContext) => void | Promise<void>,
): PreparedAgentRunAdmission {
  let binding: Promise<void> | undefined;
  return Object.freeze({
    ...prepared,
    admit: async (runtimeKind, runtimeInstanceId) => {
      const admitted = await prepared.admit(runtimeKind, runtimeInstanceId);
      const assertActive = resolveAdmittedRunActiveAssertion(admitted);
      if (!assertActive) {
        throw new Error("prepared execution authority closed during owner binding");
      }
      binding ??= Promise.resolve().then(() => {
        assertActive();
        return bind(admitted);
      });
      await binding;
      assertActive();
      return admitted;
    },
  });
}
