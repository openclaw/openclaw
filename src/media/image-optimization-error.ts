import { formatCapLimit, formatCapReduce } from "./store.shared.js";

/** Internal signal that image optimization could not satisfy its final byte budget. */
export class ImageOptimizationLimitError extends Error {
  constructor(
    message: string,
    readonly maxBytes: number,
    /** Byte size of the source image that could not fit, when known. */
    readonly sizeBytes?: number,
  ) {
    super(message);
    this.name = "ImageOptimizationLimitError";
  }

  /** An animated or pass-through image that is over the cap as-is. */
  static overCap(format: string, cap: number, sizeBytes: number): ImageOptimizationLimitError {
    return new ImageOptimizationLimitError(formatCapLimit(format, cap, sizeBytes), cap, sizeBytes);
  }

  /** A source image whose best re-encoding still exceeded the cap. */
  static notReduced(
    cap: number,
    reducedBytes: number,
    sizeBytes: number,
  ): ImageOptimizationLimitError {
    return new ImageOptimizationLimitError(
      formatCapReduce("Media", cap, reducedBytes),
      cap,
      sizeBytes,
    );
  }
}
