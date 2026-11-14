/** Definitions alone are a catalog; only a default enables named-role enforcement. */
export function isNamedOperatorRoleEnforcementEnabled(
  cfg: { readonly gateway?: { readonly roles?: { readonly default?: string } } } | undefined,
): boolean {
  return cfg?.gateway?.roles?.default !== undefined;
}
