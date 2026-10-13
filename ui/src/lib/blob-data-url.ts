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
    reader.addEventListener("error", () => reject(reader.error ?? error(readError)), {
      once: true,
    });
    reader.addEventListener(
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
