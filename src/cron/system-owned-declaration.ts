/** Retired weekly Workshop curator jobs; the store deletes these rows on load. */
export const RETIRED_SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX = "skill-collection-review:";

/** Retired namespaces stay reserved so operator jobs cannot claim keys the store removes. */
export function systemOwnedDeclarationKeyNamespace(
  declarationKey: string | undefined,
): string | undefined {
  return declarationKey?.startsWith(RETIRED_SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX)
    ? RETIRED_SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX
    : undefined;
}
