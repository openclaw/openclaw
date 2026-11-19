/** A role catalog or OpenClaw ID governs identified operators without requiring a fallback. */
export function isNamedOperatorRoleEnforcementEnabled(
  cfg:
    | {
        readonly gateway?: {
          readonly roles?: { readonly default?: string };
          readonly openclawId?: { readonly enabled?: boolean };
        };
      }
    | undefined,
): boolean {
  return cfg?.gateway?.roles !== undefined || cfg?.gateway?.openclawId?.enabled === true;
}
