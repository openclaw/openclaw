export const SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX = "skill-collection-review:";

/** Declaration-key namespaces reserved for jobs the Gateway converges itself. */
const SYSTEM_OWNED_DECLARATION_PREFIXES = [SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX];

export function systemOwnedDeclarationKeyNamespace(
  declarationKey: string | undefined,
): string | undefined {
  return SYSTEM_OWNED_DECLARATION_PREFIXES.find((prefix) => declarationKey?.startsWith(prefix));
}

export function isSystemMonitorDeclaration(declarationKey: string | undefined): boolean {
  return declarationKey?.startsWith(SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX) === true;
}
