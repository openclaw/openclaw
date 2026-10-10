import {
  getAdmittedRunDelegatedAuthority,
  type AdmittedRunContext,
} from "../../agents/admitted-run-context.js";
import type { bindUserTurnInput } from "../../sessions/user-turn-transcript-runtime-context.js";

export function createAcpTurnAdoptionFence(params: {
  input: Pick<ReturnType<typeof bindUserTurnInput>, "withCurrent">;
  admittedRunContext: AdmittedRunContext;
  onTurnAdopted?: () => void | Promise<void>;
}) {
  let adoption: Promise<void> | undefined;
  const assertTurnAuthority = () => {
    if (getAdmittedRunDelegatedAuthority(params.admittedRunContext) === undefined) {
      throw new Error("ACP turn admission ended before input dispatch.");
    }
  };
  return async () => {
    await params.input.withCurrent(assertTurnAuthority);
    // Runtime preparation can outlive the ingress claim. Adopt at the manager's
    // fallible submission fence, once across fresh-handle retries and failover.
    adoption ??= Promise.resolve().then(() => params.onTurnAdopted?.());
    await adoption;
    await params.input.withCurrent(assertTurnAuthority);
  };
}
