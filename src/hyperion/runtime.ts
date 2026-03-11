import type { OpenClawConfig } from "../config/types.js";
import { ChannelIdentityResolver } from "./channel-identity-resolver.js";
import { HyperionDynamoDBClient, type DynamoDBDocClient } from "./dynamodb-client.js";
import { HyperionPairingStore } from "./pairing-store.js";
import { TenantConfigLoader } from "./tenant-config-loader.js";
import type { HyperionDynamoDBConfig } from "./types.js";
import { UserCredentialStore, type KMSClient } from "./user-credential-store.js";

/**
 * The complete Hyperion runtime — all services wired together.
 */
export type HyperionRuntime = {
  /** DynamoDB operations for all tables. */
  dbClient: HyperionDynamoDBClient;
  /** Loads per-tenant OpenClawConfig from DynamoDB (replaces loadConfig). */
  configLoader: TenantConfigLoader;
  /** Resolves inbound webhooks to tenant identities (replaces allowFrom/pairing match). */
  identityResolver: ChannelIdentityResolver;
  /** Manages pairing codes and channel linking (replaces file-based pairing store). */
  pairingStore: HyperionPairingStore;
  /** Manages per-user encrypted credentials (API keys, bot tokens). */
  credentialStore: UserCredentialStore;
};

/**
 * Create the full Hyperion runtime with a single call.
 *
 * Usage:
 * ```ts
 * import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
 * import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
 * import { KMSClient } from "@aws-sdk/client-kms";
 * import { createHyperionRuntime } from "./hyperion/index.js";
 *
 * const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
 * const kmsClient = new KMSClient({ region: "us-east-1" });
 * const runtime = createHyperionRuntime({
 *   dynamoConfig: {
 *     region: "us-east-1",
 *     tenantConfigTableName: "Hyperion-prod-tenant-config",
 *     channelConfigTableName: "Hyperion-prod-channel-config",
 *     pairingCodesTableName: "Hyperion-prod-pairing-codes",
 *     userCredentialsTableName: "Hyperion-prod-user-credentials",
 *     credentialsKmsKeyId: "alias/hyperion-prod-credentials",
 *     channelConfigUserIdIndexName: "user_id-index",
 *   },
 *   docClient: ddbClient,
 *   kmsClient: kmsClient,
 * });
 *
 * // Portal SSE path (credentials auto-injected into config):
 * const config = await runtime.configLoader.loadTenantConfig(userId);
 *
 * // Store user credentials (encrypted at rest via KMS):
 * await runtime.credentialStore.putCredentials(userId, {
 *   model_keys: { openai: "sk-..." },
 *   tool_keys: { brave_search: "BSA..." },
 * });
 *
 * // Webhook path:
 * const identity = await runtime.identityResolver.resolve("telegram", "12345");
 *
 * // Pairing:
 * const code = await runtime.pairingStore.generatePairingCode(userId, "telegram");
 * ```
 */
export function createHyperionRuntime(params: {
  dynamoConfig: HyperionDynamoDBConfig;
  docClient: DynamoDBDocClient;
  kmsClient: KMSClient;
  defaultConfig?: Partial<OpenClawConfig>;
}): HyperionRuntime {
  const dbClient = new HyperionDynamoDBClient(params.dynamoConfig, params.docClient);
  const credentialStore = new UserCredentialStore(
    dbClient,
    params.kmsClient,
    params.dynamoConfig.credentialsKmsKeyId,
  );
  const configLoader = new TenantConfigLoader(dbClient, params.defaultConfig, credentialStore);
  const identityResolver = new ChannelIdentityResolver(dbClient, configLoader);
  const pairingStore = new HyperionPairingStore(dbClient);

  return {
    dbClient,
    configLoader,
    identityResolver,
    pairingStore,
    credentialStore,
  };
}
