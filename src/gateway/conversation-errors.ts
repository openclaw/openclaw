/** Terminal caller/input failure for Gateway-owned conversation operations. */
export class ConversationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationInputError";
  }
}
