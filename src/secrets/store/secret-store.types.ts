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
  "secrets.execEnvironment": {
    input: { excludeNames: readonly string[] };
    output: {
      type: "secrets.execEnvironment";
      rows: Pick<SecretStoreRow, "name" | "value" | "kind" | "allowed_hosts">[];
    };
  };
  "secrets.value": {
    input: { name: string };
    output: {
      type: "secrets.value";
      row: Pick<SecretStoreRow, "value" | "kind"> | undefined;
    };
  };
};
