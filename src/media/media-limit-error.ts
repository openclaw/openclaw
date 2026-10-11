/** Signals that media is larger than the byte cap of the current send path. */
export class MediaLimitError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MediaLimitError";
  }
}
