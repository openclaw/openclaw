import type { NormalizedModelCatalogRow } from "@openclaw/model-catalog-core/model-catalog-types";
type ModelCatalogEntry = Pick<NormalizedModelCatalogRow, "provider" | "id" | "name" | "inference">;

export function modelCatalogEntryMatchesTask(
  entry: Pick<ModelCatalogEntry, "inference">,
  task: "chat" | "decision" | "all" = "chat",
): boolean {
  return (
    task === "all" ||
    (task === "decision" ? Boolean(entry.inference?.decision) : entry.inference?.chat !== false)
  );
}

/** Pure projection of an already selected, policy-scoped canonical catalog. No discovery/auth. */
export function projectDecisionModelCatalog(entries: readonly ModelCatalogEntry[]) {
  return entries.flatMap((entry) => {
    const decision = entry.inference?.decision;
    if (!decision) {
      return [];
    }
    const questionTypes = (["boolean", "choice", "score"] as const).filter(
      (kind) => decision.questions?.[kind],
    );
    const limits = decision.limits;
    return [
      {
        provider: entry.provider,
        id: entry.id,
        name: entry.name,
        ...(questionTypes.length
          ? {
              capabilities: {
                questionTypes,
                ...(decision.confidence ? { confidence: decision.confidence } : {}),
                ...(decision.questions?.boolean?.requiresCriteria !== undefined
                  ? { requiresBooleanCriteria: decision.questions.boolean.requiresCriteria }
                  : {}),
                ...(limits?.maxQuestions !== undefined
                  ? { maxQuestions: limits.maxQuestions }
                  : {}),
                ...(decision.questions?.choice?.maxOptions !== undefined
                  ? { maxChoiceAlternatives: decision.questions?.choice.maxOptions }
                  : {}),
                ...(decision.questions?.score?.maxOptions !== undefined
                  ? { maxScoreLevels: decision.questions?.score.maxOptions }
                  : {}),
                ...(limits?.maxInputTokens !== undefined
                  ? { maxInputTokens: limits.maxInputTokens }
                  : {}),
                ...(limits?.inputTokenScope ? { inputTokenScope: limits.inputTokenScope } : {}),
              },
            }
          : {}),
      },
    ];
  });
}
