/** A live source still owns this input; replay must wait for its custody decision. */
export class InboundDedupePendingError extends Error {
  constructor() {
    super("Inbound message is still owned by a pending dispatch");
  }
}
