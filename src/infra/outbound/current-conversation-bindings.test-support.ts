import { onTestFinished } from "vitest";
import { currentConversationBindingPublication as publication } from "./current-conversation-bindings.publication.js";

export type CurrentConversationBindingPublication = Extract<
  Parameters<Parameters<typeof publication.subscribeFacts>[0]>[0],
  { receipt: unknown }
>;

export function recordPublications() {
  const publications: CurrentConversationBindingPublication[] = [];
  const unsubscribe = publication.subscribeFacts((value) => {
    if ("receipt" in value) {
      publications.push(value);
    }
  });
  onTestFinished(unsubscribe);
  return publications;
}
