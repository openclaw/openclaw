import type { Result } from "@openclaw/normalization-core/result";

/** Serialized store facts must not import the database owner or worker client. */
export type SecretStoreWriteInput = {
  scope: { kind: "team" };
  name: string;
  value: string;
  /** Repair replaces only matching bytes, preserving the current kind and host policy. */
  expectedValue?: string;
  kind: "secret" | "env";
  allowedHosts?: readonly string[];
  updatedBy: string | null;
};

/** Private compensation data; never projected onto a Gateway response. */
export type SecretStoreWriteReceipt = {
  scope: SecretStoreWriteInput["scope"];
  name: string;
  expectedUpdatedBy: string;
  previous:
    | {
        value: string;
        kind: SecretStoreWriteInput["kind"];
        allowedHosts: string | null;
        updatedBy: string | null;
      }
    | undefined;
};

export type SecretStoreReadResult = Result<
  string,
  | { code: "SECRET_STORE_NOT_FOUND"; message: string }
  | { code: "SECRET_STORE_INVALID_NAME"; message: string }
  | { code: "SECRET_STORE_UNAVAILABLE"; message: string; cause: unknown }
>;

export type SecretStoreWorkerOperations = {
  "secrets.store.stage": { input: SecretStoreWriteInput; output: SecretStoreWriteReceipt };
  "secrets.store.rollback": { input: SecretStoreWriteReceipt; output: boolean };
};
