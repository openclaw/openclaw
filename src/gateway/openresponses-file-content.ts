import { wrapExternalContent } from "../security/external-content.js";

/** Wrap file text as untrusted Responses input without adding an extra warning block. */
export function wrapUntrustedFileContent(content: string): string {
  return wrapExternalContent(content, {
    source: "unknown",
    includeWarning: false,
  });
}
