import type { Selectable } from "kysely";
import type { DB } from "../../state/openclaw-state-db.generated.js";

export type SecretStoreScope = { kind: "team" };
export type SecretStoreKind = "secret" | "env";
export type SecretStoreRow = Selectable<DB["secret_store_entries"]>;
export type SecretStoreListInput = {
  scope: SecretStoreScope;
  includeDeleted?: boolean;
  redactedOnly?: boolean;
};
export type SecretStoreReadOperations = {
  "secrets.metadata": {
    input: SecretStoreListInput;
    output: { type: "secrets.metadata"; rows: SecretStoreRow[] };
  };
};
