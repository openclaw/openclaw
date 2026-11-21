import { listen } from "./reactive/listener.ts";

type ReadErrorMessage = string | (() => string);

export function readBlobAsDataUrl(blob: Blob, errorMessage?: ReadErrorMessage): Promise<string> {
  const error = (fallback: string) =>
    new Error(typeof errorMessage === "function" ? errorMessage() : (errorMessage ?? fallback));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    // The private reader owns these one-shot handlers for its single read.
    listen(reader, "error", () => reject(reader.error ?? error("Blob read failed")), {
      once: true,
    });
    listen(
      reader,
      "load",
      () =>
        typeof reader.result === "string"
          ? resolve(reader.result)
          : reject(error("Blob read returned no data")),
      { once: true },
    );
    reader.readAsDataURL(blob);
  });
}
