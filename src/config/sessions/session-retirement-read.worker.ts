import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { assertOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { readComparisonClaim } from "./legacy-main-session-migration-claims.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import type {
  SessionRetirementReadResult,
  SessionRetirementReadWorkerInput,
} from "./session-retirement-read.types.js";

export function readSessionRetirementInWorker(
  input: SessionRetirementReadWorkerInput,
): SessionRetirementReadResult {
  const request = input.request;
  const result = withOpenClawAgentDatabaseReadOnly(
    (database): SessionRetirementReadResult => {
      assertOpenClawAgentDatabaseIdentity(database, input.expectedIdentity);
      if (request.operation === "keys") {
        const query = getSessionKysely(database.db)
          .selectFrom("session_nodes")
          .select("session_key");
        return {
          operation: "keys",
          keys: executeSqliteQuerySync(
            database.db,
            request.ordered ? query.orderBy("session_key") : query,
          ).rows.map((row) => row.session_key),
        };
      }
      return {
        operation: "comparison-claims",
        claims: request.keys.flatMap(({ key, canonicalKey }) => {
          const claim = readComparisonClaim(database, request.store, key, canonicalKey);
          return claim ? [claim] : [];
        }),
      };
    },
    { ...input.database, env: cloneEnvWithPlatformSemantics(input.env) },
  );
  return result.found
    ? result.value
    : request.operation === "keys"
      ? { operation: "keys", keys: [] }
      : { operation: "comparison-claims", claims: [] };
}
