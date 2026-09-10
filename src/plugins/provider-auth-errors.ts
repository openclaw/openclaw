export class ProviderCredentialsSavedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderCredentialsSavedError";
  }
}
