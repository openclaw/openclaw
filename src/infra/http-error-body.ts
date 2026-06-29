import { readResponseTextSnippet } from "./http-body.js";

export async function readResponseBodySnippet(
  response: Response,
  limits: { maxBytes: number; maxChars: number },
): Promise<string> {
  try {
    return (
      (await readResponseTextSnippet(response, {
        maxBytes: limits.maxBytes,
        maxChars: limits.maxChars,
      })) ?? ""
    );
  } catch {
    return "";
  }
}
