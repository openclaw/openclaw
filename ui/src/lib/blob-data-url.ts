import { listen } from "./reactive/listener.ts";

type ReadErrorMessage = string | (() => string);

export function readBlobAsDataUrl(
  blob: Blob,
  {
    readError = "Blob read failed",
    invalidResultError = "Blob read returned no data",
  }: { readError?: ReadErrorMessage; invalidResultError?: ReadErrorMessage } = {},
): Promise<string> {
  const error = (message: ReadErrorMessage) =>
    new Error(typeof message === "function" ? message() : message);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    // The private reader owns these one-shot handlers for its single read.
    listen(reader, "error", () => reject(reader.error ?? error(readError)), {
      once: true,
    });
    listen(
      reader,
      "load",
      () =>
        typeof reader.result === "string"
          ? resolve(reader.result)
          : reject(error(invalidResultError)),
      { once: true },
    );
    reader.readAsDataURL(blob);
  });
}
