/** Retired weekly Workshop curator jobs; the store deletes these rows on load. */
export const RETIRED_SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX = "skill-collection-review:";

/** Reserved creation namespaces for retired system declarations. */
const SYSTEM_OWNED_DECLARATION_PREFIXES = [
  // Stays reserved so an operator job cannot claim a key the store retires.
  RETIRED_SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX,
];

export function systemOwnedDeclarationKeyNamespace(
  declarationKey: string | undefined,
): string | undefined {
  return SYSTEM_OWNED_DECLARATION_PREFIXES.find((prefix) => declarationKey?.startsWith(prefix));
}
