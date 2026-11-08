export class ProviderCredentialsSavedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderCredentialsSavedError";
  }
}

/** A provider login committed credentials before its settings write failed. */
export class ProviderAuthConfigApplyError extends ProviderCredentialsSavedError {
  constructor(cause: unknown) {
    super(
      `Credentials saved, but provider settings could not be applied: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "ProviderAuthConfigApplyError";
  }
}
