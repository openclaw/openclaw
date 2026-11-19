/** A role catalog governs identified operators without requiring a fallback. */
export function isNamedOperatorRoleEnforcementEnabled(
  cfg: { readonly gateway?: { readonly roles?: { readonly default?: string } } } | undefined,
): boolean {
  return cfg?.gateway?.roles !== undefined;
}
