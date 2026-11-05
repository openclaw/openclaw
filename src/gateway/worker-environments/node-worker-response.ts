/** Decode the private node response envelope before its operation validates the payload. */
export function parseNodeWorkerResponse(
  value: string | null | undefined,
  operation: string,
): unknown {
  if (!value) {
    throw new Error(operation + " omitted its result");
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(operation + " returned malformed JSON");
  }
}
