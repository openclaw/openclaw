const CLAIM_ADMISSION = Symbol.for("openclaw.claimingHookAdmission");

export type ClaimingHookAdmission = Readonly<{
  [CLAIM_ADMISSION]?: () => Promise<void>;
}>;

export function withClaimingHookAdmission<T extends object>(
  context: T,
  assertCurrent: (() => Promise<void>) | undefined,
) {
  return assertCurrent ? Object.assign(context, { [CLAIM_ADMISSION]: assertCurrent }) : context;
}

export function readClaimingHookAdmission(context: ClaimingHookAdmission) {
  return context[CLAIM_ADMISSION];
}
