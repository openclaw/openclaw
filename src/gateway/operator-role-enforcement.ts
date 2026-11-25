import { isOpenClawIdProfileMember } from "./openclaw-id/tunnel-principal.js";

type OperatorRoleConfig = {
  readonly gateway?: { readonly roles?: { readonly default?: string } };
};

export type OperatorRoleSubject = {
  profileId: string | undefined;
  openclawIdMember: boolean;
};

/** A default enables the installation-wide named-role boundary. */
export function isNamedOperatorRoleEnforcementEnabled(
  cfg: OperatorRoleConfig | undefined,
): boolean {
  return cfg?.gateway?.roles?.default !== undefined;
}

/** A catalog alone governs only a person with a current OpenClaw ID membership. */
export function isOperatorRoleEnforcedFor(
  cfg: OperatorRoleConfig | undefined,
  subject: OperatorRoleSubject,
): boolean {
  return (
    isNamedOperatorRoleEnforcementEnabled(cfg) ||
    (cfg?.gateway?.roles !== undefined && subject.openclawIdMember)
  );
}

/** Join prepared canonical account links with the service's resident membership owner. */
export function operatorRoleSubject(
  profile:
    | { profileId?: string; id?: string; openclawIdAccountIds?: readonly string[] }
    | undefined,
): OperatorRoleSubject {
  return {
    profileId: profile?.profileId ?? profile?.id,
    openclawIdMember: isOpenClawIdProfileMember(profile?.openclawIdAccountIds),
  };
}
