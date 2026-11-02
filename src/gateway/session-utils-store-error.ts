import { attachErrorDiagnostic } from "../infra/error-diagnostics.js";
import { formatErrorMessageWithCode } from "../infra/errors.js";
import type { NativeErrorResponse } from "../infra/native-error-response-schema.js";

export class SessionStoreUnavailableError extends Error {
  constructor(
    agentId: string,
    readonly reason: "schema-missing" | "read-failed",
    readonly readError?: NativeErrorResponse,
  ) {
    const nativeKind = readError?.code ?? readError?.name;
    const suffix =
      nativeKind && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(nativeKind) ? `: ${nativeKind}` : "";
    super(
      `Session stores for agent ${agentId} are unavailable (${reason}${suffix}); retry after storage is available.`,
    );
    this.name = "SessionStoreUnavailableError";
    // Native messages can contain private paths; keep them out of message/cause and RPC JSON.
    if (readError) {
      attachErrorDiagnostic(this, `${readError.name}: ${formatErrorMessageWithCode(readError)}`);
    }
  }
}
