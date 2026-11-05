import { createHmac, randomBytes } from "node:crypto";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";

export type GatewayConfigRevisionProjector = {
  projectRawHash: (hash: string) => string;
  projectResolvedHash: (hash: string) => string;
  hashResponseSessionBearer: (bearer: string) => string;
};

const CONFIG_REVISION_KEY_BYTES = 32;
const CONFIG_REVISION_RAW_DOMAIN = "openclaw.gateway.config-revision.raw.v1";
const CONFIG_REVISION_RESOLVED_DOMAIN = "openclaw.gateway.config-revision.resolved.v1";

function registerConfigRevisionKeyForRedaction(key: Uint8Array): void {
  const bytes = Buffer.from(key);
  registerSecretValueForRedaction(bytes.toString("hex"));
  registerSecretValueForRedaction(bytes.toString("base64url"));
}

function parseConfigRevisionKey(key: Uint8Array): Uint8Array {
  if (!(key instanceof Uint8Array) || key.byteLength !== CONFIG_REVISION_KEY_BYTES) {
    // Public revision tokens are a config-redaction boundary. Corrupt key material
    // must fail closed instead of rotating or falling back to a deterministic digest.
    throw new Error("config revision key is corrupt");
  }
  const bytes = Buffer.from(key);
  registerConfigRevisionKeyForRedaction(bytes);
  return bytes;
}

function projectRevision(key: Uint8Array, domain: string, hash: string): string {
  const digest = createHmac("sha256", key)
    .update(JSON.stringify([domain, hash]), "utf8")
    .digest("base64url");
  return `hmac-sha256:v1:${digest}`;
}

function createGatewayConfigRevisionProjector(key: Uint8Array): GatewayConfigRevisionProjector {
  if (key.byteLength !== CONFIG_REVISION_KEY_BYTES) {
    throw new Error("config revision key must be 32 bytes");
  }
  return {
    projectRawHash: (hash) => projectRevision(key, CONFIG_REVISION_RAW_DOMAIN, hash),
    projectResolvedHash: (hash) => projectRevision(key, CONFIG_REVISION_RESOLVED_DOMAIN, hash),
    hashResponseSessionBearer: (bearer) => hashGatewayResponseSessionBearer(bearer, key),
  };
}

/** Loads the durable installation key once for the Gateway request lifecycle. */
export async function loadGatewayConfigRevisionProjector(
  options: OpenClawStateDatabaseOptions = {},
): Promise<GatewayConfigRevisionProjector> {
  const context = captureOpenClawStateWorkerContext(options);
  const key = await runOpenClawStateWorkerOperation(context, (scope) =>
    scope.execute({
      type: "machineState.configRevisionKey",
      input: { candidateKey: randomBytes(CONFIG_REVISION_KEY_BYTES) },
    }),
  );
  return createGatewayConfigRevisionProjector(parseConfigRevisionKey(key));
}

function hashGatewayResponseSessionBearer(bearer: string, key: Uint8Array): string {
  const scopeKey = createHmac("sha256", key).update("openresponses-session-scope", "utf8").digest();
  try {
    return `hmac-sha256:v1:${createHmac("sha256", scopeKey).update(bearer, "utf8").digest("hex")}`;
  } finally {
    scopeKey.fill(0);
  }
}
