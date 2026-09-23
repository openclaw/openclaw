import { UpdateActivationTimeoutError } from "../cli/update-cli/update-command-activation.js";

/** Diagnostic write lifetime, never native mutation authority or a serialized grant. */
export type FreeBsdUpdateWriteAdmission = {
  readonly canWrite: boolean;
  readonly failure: (Error & { readonly reason?: string }) | undefined;
  assertCurrent: () => void;
  revoke: (cause: unknown) => Error;
  revalidate: (assertAuthority: () => void, inspect?: () => Promise<void>) => Promise<void>;
};

class FreeBsdUpdateWriteAdmissionError extends Error {
  readonly reason = "freebsd-update-ownership";

  constructor() {
    super("FreeBSD update write admission is pending or revoked; history remains with its owner.");
    this.name = "FreeBsdUpdateWriteAdmissionError";
  }
}

/** Canonical owners admit selected state. Keep their first refusal after native
 * release so late progress, signals and diagnostics cannot reopen rejected state. */
export function createFreeBsdUpdateWriteAdmission(): FreeBsdUpdateWriteAdmission | undefined {
  if (process.platform !== "freebsd") {
    return undefined;
  }
  let admitted = false;
  let checking = false;
  let failure: FreeBsdUpdateWriteAdmission["failure"];
  const admission: FreeBsdUpdateWriteAdmission = {
    get canWrite() {
      return admitted && !checking && !failure;
    },
    get failure() {
      return failure;
    },
    revoke(cause) {
      // Expiry ends effects, not custody. Native refusal still wins, including
      // one observed after expiry while the original operation is settling.
      if (cause instanceof UpdateActivationTimeoutError) {
        return failure ?? cause;
      }
      failure ??=
        cause instanceof Error ? cause : new Error("Update authority was lost", { cause });
      return failure;
    },
    assertCurrent() {
      if (!admission.canWrite) {
        throw admission.revoke(new FreeBsdUpdateWriteAdmissionError());
      }
    },
    async revalidate(assertAuthority, inspect) {
      if (checking || failure) {
        throw admission.revoke(new FreeBsdUpdateWriteAdmissionError());
      }
      // A concurrent refusal wins even if the earlier asynchronous check succeeds.
      checking = true;
      try {
        assertAuthority();
        await inspect?.();
        assertAuthority();
        const refusal = admission.failure;
        if (refusal) {
          throw refusal;
        }
        admitted = true;
      } catch (cause) {
        throw admission.revoke(cause);
      } finally {
        checking = false;
      }
    },
  };
  return admission;
}

/** Observe authority checks only. Ordinary operation failures retain diagnostic
 * publication after clean settlement; an authority failure can never revive it. */
export function assertUpdateWriteAuthority(
  admission: FreeBsdUpdateWriteAdmission | undefined,
  assertAuthority: () => void,
): void {
  try {
    admission?.assertCurrent();
    assertAuthority();
  } catch (cause) {
    throw admission?.revoke(cause) ?? cause;
  }
}
