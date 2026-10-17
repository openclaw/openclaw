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
    // This private reader performs one read; its callbacks share that operation's lifetime.
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? error(readError));
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(error(invalidResultError));
    reader.readAsDataURL(blob);
  });
}
