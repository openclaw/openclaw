import { readTransportDiagnosticLabel } from "../../packages/ai/src/utils/provider-error.js";
import type { MediaAttachmentDisposition } from "../../packages/media-understanding-common/src/types.js";
import { ProviderHttpError } from "../agents/provider-http-errors.js";

/** Keeps a provider HTTP failure's own status and code; other errors stay unannotated. */
export function failedAttachmentDisposition(error: unknown): MediaAttachmentDisposition {
  if (!(error instanceof ProviderHttpError)) {
    return { kind: "failed" };
  }
  const code = readTransportDiagnosticLabel(error.code);
  return { kind: "failed", status: error.status, ...(typeof code === "string" ? { code } : {}) };
}
