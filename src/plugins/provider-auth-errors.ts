export class ProviderCredentialsSavedError extends Error {
  constructor(cause: unknown) {
    super(
      cause instanceof Error
        ? `Provider credentials were saved, but sign-in did not finish: ${cause.message}`
        : "Provider credentials were saved, but sign-in did not finish.",
      { cause },
    );
    this.name = "ProviderCredentialsSavedError";
  }
}
