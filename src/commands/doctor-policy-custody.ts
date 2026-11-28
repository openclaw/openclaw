import type { UpdateDoctorWriteAuthority } from "../infra/update-doctor-result.js";

/**
 * A delegated policy check can read shared state (profile-linked requesters do)
 * while Doctor holds maintenance ownership outside a maintenance scope, e.g. on
 * child-process custody or post-repair work. The held owner lends storage
 * custody to every check, as it does for Doctor's own policy reads; each check
 * still reads current policy.
 */
export function createDoctorWriteAuthority(
  authority: UpdateDoctorWriteAuthority,
): UpdateDoctorWriteAuthority {
  let owner: Parameters<NonNullable<UpdateDoctorWriteAuthority["lendPolicyCustody"]>>[0];
  const assertPolicy = authority.assertCurrent;
  return {
    ...authority,
    assertCurrent: () => (owner ? owner.assertCurrent(assertPolicy) : assertPolicy()),
    lendPolicyCustody: (next) => {
      owner = next;
    },
  };
}
