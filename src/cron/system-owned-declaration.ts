export const HEARTBEAT_TASK_DECLARATION_PREFIX = "heartbeat-task:";
export const HEARTBEAT_DECLARATION_PREFIX = "heartbeat:";
/** Retired weekly Workshop curator jobs; the store deletes these rows on load. */
export const RETIRED_SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX = "skill-collection-review:";

/** Reserved creation namespaces, including Doctor-imported operator tasks. */
const SYSTEM_OWNED_DECLARATION_PREFIXES = [
  HEARTBEAT_TASK_DECLARATION_PREFIX,
  HEARTBEAT_DECLARATION_PREFIX,
  // Stays reserved so an operator job cannot claim a key the store retires.
  RETIRED_SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX,
];

export function systemOwnedDeclarationKeyNamespace(
  declarationKey: string | undefined,
): string | undefined {
  return SYSTEM_OWNED_DECLARATION_PREFIXES.find((prefix) => declarationKey?.startsWith(prefix));
}

export function isSystemMonitorDeclaration(declarationKey: string | undefined): boolean {
  // Imported heartbeat tasks remain operator-editable; only monitors are config-owned.
  return declarationKey?.startsWith(HEARTBEAT_DECLARATION_PREFIX) === true;
}
