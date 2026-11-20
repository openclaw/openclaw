/** The publication owner lost a durable authority write's outcome; retry cannot settle it. */
export class SessionSharingAuthorityUnknownError extends Error {
  constructor() {
    super(
      "Session sharing acquisition is no longer current: authority is unknown; restart the Gateway after an unconfirmed storage write.",
    );
    this.name = "SessionSharingAuthorityUnknownError";
  }
}
