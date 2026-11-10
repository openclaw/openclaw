// Shared by the secrets-store CLI and its input helpers: a secret-store input
// file (--value-file / --from) could not be opened or is not a regular file.
// Kept in its own module so the CLI can statically reference the class without
// loading the input helpers' heavier dependencies (prompts, media-core) at
// command-parse time.
export class SecretStoreInputFileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SecretStoreInputFileError";
  }
}
