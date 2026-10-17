const CLAIM_ADMISSION = Symbol.for("openclaw.claimingHookAdmission");

export type ClaimingHookAdmission = Readonly<{
  [CLAIM_ADMISSION]?: Readonly<{
    prepare?: () => Promise<void>;
    /** Host-only invocation custody, closed after each handler (including timeout). */
    run?: <T>(run: () => Promise<T>) => Promise<T>;
    assertCurrent?: () => void;
  }>;
}>;

export function withClaimingHookAdmission<T extends object>(
  context: T,
  admission: ClaimingHookAdmission[typeof CLAIM_ADMISSION],
) {
  return admission ? Object.assign(context, { [CLAIM_ADMISSION]: admission }) : context;
}

export function readClaimingHookAdmission(context: object & ClaimingHookAdmission) {
  return context[CLAIM_ADMISSION];
}

/** Keep the handler wrapper inside host custody, including its timeout and cleanup. */
export function invoke<T>(
  admission: ReturnType<typeof readClaimingHookAdmission>,
  handler: () => Promise<T>,
  wrap?: (run: () => Promise<T>) => Promise<T>,
): Promise<T> {
  const run = () => (wrap ? wrap(handler) : handler());
  return admission?.run ? admission.run(run) : run();
}
