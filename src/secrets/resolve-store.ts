import type { SecretRef } from "../config/types.secrets.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { captureOpenClawStateReadWorkerContext } from "../state/openclaw-state-worker-context.js";
import { providerResolutionError, refResolutionError } from "./resolve-errors.js";
import type { SecretRefErrorHandler } from "./resolve-types.js";
import { readSecretStoreValue, SECRET_STORE_VALUE_MAX_BYTES } from "./store/secret-store.js";

// Store values intentionally support large PEM/JSON payloads, so this batch cap is
// independent from the 256 KiB request cap used by file and exec providers.
const STORE_SECRET_REF_BATCH_MAX_BYTES = 512 * SECRET_STORE_VALUE_MAX_BYTES;

export async function resolveStoreRefs(params: {
  refs: SecretRef[];
  providerName: string;
  onRefError: SecretRefErrorHandler;
  database?: OpenClawStateDatabaseOptions;
}): Promise<Map<string, unknown>> {
  const context = captureOpenClawStateReadWorkerContext(params.database);
  const resolved = new Map<string, unknown>();
  let resolvedBytes = 0;
  for (const ref of params.refs) {
    const result = await readSecretStoreValue({
      scope: { kind: "team" },
      name: ref.id,
      context,
    });
    context.admission.assertCurrent();
    if (!result.ok) {
      if (
        result.error.code === "SECRET_STORE_NOT_FOUND" ||
        result.error.code === "SECRET_STORE_INVALID_NAME"
      ) {
        params.onRefError(
          refResolutionError({
            code:
              result.error.code === "SECRET_STORE_NOT_FOUND"
                ? "SECRET_REF_NOT_FOUND"
                : "SECRET_REF_INVALID",
            source: "store",
            provider: params.providerName,
            refId: ref.id,
            message: result.error.message,
          }),
        );
        continue;
      }
      throw providerResolutionError({
        code: "SECRET_PROVIDER_UNAVAILABLE",
        source: "store",
        provider: params.providerName,
        message: result.error.message,
        cause: result.error.cause,
      });
    }
    resolvedBytes += Buffer.byteLength(result.value, "utf8");
    if (resolvedBytes > STORE_SECRET_REF_BATCH_MAX_BYTES) {
      throw providerResolutionError({
        code: "SECRET_PROVIDER_INVALID",
        source: "store",
        provider: params.providerName,
        message: `Store provider "${params.providerName}" exceeded its ${STORE_SECRET_REF_BATCH_MAX_BYTES}-byte batch limit.`,
      });
    }
    resolved.set(ref.id, result.value);
  }
  return resolved;
}
