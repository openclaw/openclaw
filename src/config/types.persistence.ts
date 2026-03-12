import type { SecretInput } from "./types.secrets.js";

export type PersistenceBackend = "filesystem" | "postgres";

export type PersistencePostgresConfig = {
  url?: SecretInput;
  schema?: string;
  maxConnections?: number;
  encryptionKey?: SecretInput;
  exportCompatibility?: boolean;
};

export type PersistenceConfig = {
  backend?: PersistenceBackend;
  postgres?: PersistencePostgresConfig;
};
