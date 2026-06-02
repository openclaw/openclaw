import { wrapExternalContent } from "../security/external-content.js";

// OpenResponses already renders a filename/source wrapper around file text;
// this inner wrapper keeps untrusted-content fences without duplicating the
// warning banner inside every file context block.
export function wrapUntrustedFileContent(content: string): string {
  return wrapExternalContent(content, {
    source: "unknown",
    includeWarning: false,
  });
}
