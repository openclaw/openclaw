import { operatorScopeSatisfied } from "../shared/operator-scope-compat.js";
import { QUESTIONS_SCOPE } from "./operator-scopes.js";
import type { QuestionManager } from "./question-manager.js";
import type { GatewayClient } from "./server-methods/client-types.js";

export function usesOwnRunQuestionAccess(client: GatewayClient | null): boolean {
  return Boolean(
    client?.connect && !operatorScopeSatisfied(QUESTIONS_SCOPE, client.connect.scopes ?? []),
  );
}

/** Select the original person before liveness reads; full session authorization still follows. */
export function canSelectQuestion(
  manager: QuestionManager,
  id: string,
  client: GatewayClient | null,
): boolean {
  return (
    !usesOwnRunQuestionAccess(client) ||
    manager.observe(id)?.sessionAccess?.canSelect(client) === true
  );
}
