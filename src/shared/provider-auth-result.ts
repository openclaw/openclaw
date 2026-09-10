/** A provider login committed credentials before its settings write failed. */
export class ProviderAuthConfigApplyError extends Error {
  constructor(cause: unknown) {
    super(
      `Credentials saved, but provider settings could not be applied: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "ProviderAuthConfigApplyError";
  }
}
