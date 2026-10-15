import { isDeepStrictEqual } from "node:util";
import type { DurableQuestion } from "./session-questions.types.js";

/** Lost-ack registration recovery accepts only the originally owned definition. */
export function matchesDurableQuestionDefinition(
  current: DurableQuestion,
  requested: DurableQuestion,
): boolean {
  const definition = (question: DurableQuestion) => ({
    ...question.record,
    status: "pending",
    answers: undefined,
    resolvedBy: undefined,
    createdAtMs: undefined,
    expiresAtMs: undefined,
  });
  // Definitions cross the worker's JSON boundary. Omitted optional fields and
  // explicit undefined fields represent the same persisted custody, at every depth.
  const persisted = (value: unknown): unknown => {
    const serialized = JSON.stringify(value);
    return JSON.parse(serialized);
  };
  return (
    requested.record.status === "pending" &&
    isDeepStrictEqual(persisted(definition(current)), persisted(definition(requested))) &&
    current.record.expiresAtMs - current.record.createdAtMs ===
      requested.record.expiresAtMs - requested.record.createdAtMs &&
    current.sessionKey === requested.sessionKey &&
    current.sessionId === requested.sessionId &&
    current.lifecycleRevision === requested.lifecycleRevision &&
    isDeepStrictEqual(persisted(current.provenance), persisted(requested.provenance)) &&
    isDeepStrictEqual(persisted(current.sessionBinding), persisted(requested.sessionBinding))
  );
}
