import type { ClientCredentialFileIdentity } from "./client-credential-receipt.js";

export type ClientCredentialRehearsalBinding = {
  sourceSharedFile: ClientCredentialFileIdentity;
  sourceStateRoot: string;
  sharedPath: string;
  localPath: string;
  postgresStoreId?: string;
  postgresExportDirectory?: string;
};
