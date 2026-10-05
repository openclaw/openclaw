import { isDeepStrictEqual } from "node:util";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SqliteWorkerAdmissionFactory } from "../../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerStore } from "../../infra/sqlite-worker-store.js";
import type { AgentDatabaseIncognitoOperations } from "../../state/openclaw-agent-execution-contract.js";
import type {
  IncognitoSessionAuthority,
  IncognitoSessionFacts,
} from "./session-incognito-contract.js";

export function readIncognitoGrantFacts(
  received: unknown,
  identity: IncognitoSessionFacts["identity"],
): IncognitoSessionFacts[] {
  if (
    !Array.isArray(received) ||
    received.some(
      (facts: unknown) =>
        !isRecord(facts) ||
        !isDeepStrictEqual(facts.identity, identity) ||
        typeof facts.sessionKey !== "string" ||
        !Number.isSafeInteger(facts.revision),
    )
  ) {
    throw new Error("Incognito session grant differs from its captured target");
  }
  // SAFETY: The paired kernel supplies these actor-bound publication facts.
  return received as IncognitoSessionFacts[];
}

export function authorizeSessionFacts(
  authority: IncognitoSessionAuthority,
  stage: "transaction" | "commit",
  facts: IncognitoSessionFacts,
) {
  const authorization: unknown = authority.authorize?.(stage, structuredClone(facts));
  if (isPromiseLike(authorization)) {
    void Promise.resolve(authorization).catch(() => undefined);
    throw new Error("Incognito session grants must remain synchronous");
  }
}

type Scope = Pick<SqliteWorkerStore<AgentDatabaseIncognitoOperations>, "execute">;

export type IncognitoSessionRunner = <T>(
  authority: IncognitoSessionAuthority,
  operation: (scope: Scope) => Promise<T>,
  signal?: AbortSignal,
  admission?: SqliteWorkerAdmissionFactory,
  cleanup?: boolean,
) => Promise<T>;
