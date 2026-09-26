import {
  ErrorCodes,
  errorShape,
  type QuestionSourceBindingRoute,
} from "../../packages/gateway-protocol/src/index.js";
import { resolveConversationBindingSelection } from "../channels/conversation-binding-route-facts.js";
import { readSessionBindingSelectionCurrent } from "../infra/outbound/session-binding-service.js";
import type { RespondFn } from "./server-methods/types.js";

function sameConversation(
  left: QuestionSourceBindingRoute["conversation"],
  right: QuestionSourceBindingRoute["conversation"],
): boolean {
  return (
    left.channel === right.channel &&
    left.accountId === right.accountId &&
    left.conversationId === right.conversationId &&
    left.parentConversationId === right.parentConversationId
  );
}

/** Reads shared binding ownership immediately before a question resolution commits. */
async function inspectQuestionSourceBindingRoutes(
  routes: readonly QuestionSourceBindingRoute[],
): Promise<"current" | "changed" | "unavailable"> {
  try {
    const current = await readSessionBindingSelectionCurrent(
      routes.map((route) => route.conversation),
    );
    const changed = routes.some((route, index) => {
      const expected = route.selection;
      const selection = resolveConversationBindingSelection(current[index] ?? null);
      if (expected.kind === "unavailable") {
        return true;
      }
      if (expected.kind === "none") {
        return selection.kind !== "none";
      }
      const binding = selection.kind === "none" ? null : selection.binding;
      return (
        !binding ||
        binding.bindingId !== expected.bindingId ||
        binding.boundAt !== expected.boundAt ||
        binding.targetSessionKey !== expected.targetSessionKey ||
        binding.targetKind !== expected.targetKind ||
        !sameConversation(expected.conversation, binding.conversation)
      );
    });
    return changed ? "changed" : "current";
  } catch {
    return "unavailable";
  }
}

/** Couples the last shared-state read to the synchronous question commit callback. */
export function prepareQuestionSourceBindingGuard(
  routes: readonly QuestionSourceBindingRoute[] | undefined,
) {
  let status: Awaited<ReturnType<typeof inspectQuestionSourceBindingRoutes>> | undefined;
  return {
    beforeConsume: routes
      ? async () => {
          status = await inspectQuestionSourceBindingRoutes(routes);
        }
      : undefined,
    authorize: (respond: RespondFn): boolean => {
      if (status === undefined || status === "current") {
        return true;
      }
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.FORBIDDEN,
          status === "changed"
            ? "Question source binding changed before resolution."
            : "Question source binding is unavailable.",
          {
            details: {
              reason:
                status === "changed"
                  ? "QUESTION_SOURCE_BINDING_CHANGED"
                  : "QUESTION_SOURCE_BINDING_UNAVAILABLE",
            },
          },
        ),
      );
      return false;
    },
  };
}
