import type { ClientCredentialFileIdentity } from "./client-credential-receipt.js";

export type ClientCredentialRehearsalBinding = {
  sourceSharedFile: ClientCredentialFileIdentity;
  sharedPath: string;
  localPath: string;
  postgresStoreId?: string;
  postgresExportDirectory?: string;
};
