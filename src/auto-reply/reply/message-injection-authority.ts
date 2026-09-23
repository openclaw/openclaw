/** A refused owner assertion is terminal for this input, not permission to redispatch it. */
export class MessageInjectionAuthorityError extends Error {
  constructor(options?: ErrorOptions) {
    super("Message injection authority is no longer current", options);
    this.name = "MessageInjectionAuthorityError";
  }
}

/** One injection stays revoked even if its source later appears current again. */
export function createMessageInjectionAuthority(canInject: () => boolean): () => void {
  let revoked: MessageInjectionAuthorityError | undefined;
  return () => {
    if (!revoked) {
      try {
        if (canInject()) {
          return;
        }
      } catch (cause) {
        revoked = new MessageInjectionAuthorityError({ cause });
      }
      revoked ??= new MessageInjectionAuthorityError();
    }
    throw revoked;
  };
}
