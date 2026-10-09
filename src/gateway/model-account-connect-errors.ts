export class ModelAccountConnectAuthorityError extends Error {
  constructor() {
    super("This account action requires a current authorized connection; reconnect and try again.");
  }
}

export class ModelAccountConnectInputError extends Error {}
