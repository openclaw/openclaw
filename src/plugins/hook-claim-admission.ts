const CLAIM_ADMISSION = Symbol.for("openclaw.claimingHookAdmission");

export type ClaimingHookAdmission = Readonly<{
  [CLAIM_ADMISSION]?: Readonly<{
    prepare?: () => Promise<void>;
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
