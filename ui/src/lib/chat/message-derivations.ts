import type { NormalizedMessage, ToolCard } from "./chat-types.ts";

type MessageDerivations = {
  revision: string | undefined;
  normalized: NormalizedMessage | undefined;
  toolCards: ToolCard[] | undefined;
};

// Immutable source messages share one weak entry. Each consumer still
// admits and computes its own field.
const messageDerivations = new WeakMap<object, MessageDerivations>();

export function readMessageDerivations(message: object): MessageDerivations | undefined {
  return messageDerivations.get(message);
}

export function getMessageDerivations(message: object): MessageDerivations {
  let facts = messageDerivations.get(message);
  if (!facts) {
    facts = {
      revision: undefined,
      normalized: undefined,
      toolCards: undefined,
    };
    messageDerivations.set(message, facts);
  }
  return facts;
}
