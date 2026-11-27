import { VocabularyError, type VocabularyTerm } from "./vocabulary-types.js";

/**
 * Proposed private preparation inputs, not a persistence format or public SDK contract.
 * The authenticated host must supply an admitted personal read before invoking these helpers.
 * Identifiers describe its provenance; knowing them never grants read or dispatch authority.
 */
export type PersonalVocabularyScope = Readonly<{
  profileId: string;
  workspaceId: string;
}>;

export type PersonalVocabularyInput = Readonly<{
  scope: PersonalVocabularyScope;
  revision: number;
  enabled: boolean;
  /** Admitted by the shared vocabulary validator, including its immutable nested lists. */
  terms: readonly VocabularyTerm[];
}>;

/** Scope equality is an isolation check on an already authorized read, never authorization. */
export function assertPersonalVocabularyScope(
  actual: PersonalVocabularyScope,
  selected: PersonalVocabularyScope,
): void {
  if (actual.profileId !== selected.profileId || actual.workspaceId !== selected.workspaceId) {
    throw new VocabularyError("unavailable");
  }
}
