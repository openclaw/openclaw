import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import {
  executeExistingOpenClawStateRead,
  withExistingOpenClawStateDatabaseCurrentReadOnly,
} from "../state/openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import {
  readSessionUpstreamLinkInDatabase,
  type SessionUpstreamLink,
} from "./session-upstream-links.kernel.js";
import type { SessionUpstreamSettlement } from "./session-upstream-links.worker-contract.js";

export type SessionUpstreamLinkReadSource = ReturnType<typeof captureSessionUpstreamLinkReadSource>;

/** Missing-path admissions may later promote; this read keeps its original physical source. */
export function captureSessionUpstreamLinkReadSource(
  context: OpenClawStateWorkerContext = captureOpenClawStateWorkerContext(),
) {
  const identity = { ...context.admission.identity };
  return {
    context,
    present: identity.key.startsWith("file:"),
    assertCurrent() {
      context.admission.assertCurrent();
    },
  };
}

export async function prepareSessionUpstreamLink(
  source: SessionUpstreamLinkReadSource,
  sessionKey: string,
  agentId: string,
): Promise<SessionUpstreamLink | undefined> {
  source.assertCurrent();
  if (!source.present) {
    return undefined;
  }
  const { context } = source;
  const result = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    { type: "sessionUpstream.read", input: { sessionKey, agentId } },
    { context, current: true },
  );
  source.assertCurrent();
  if (!result?.ok || result.type !== "sessionUpstream.read") {
    throw new Error("Session upstream source is unavailable");
  }
  return result.link;
}

/** Final native guards remain current even when a foreign or released SDK writer bypasses publication. */
export function readCurrentSessionUpstreamLink(
  source: SessionUpstreamLinkReadSource,
  sessionKey: string,
  agentId: string,
): SessionUpstreamLink | undefined {
  source.assertCurrent();
  if (!source.present) {
    return undefined;
  }
  const { context } = source;
  const result = withExistingOpenClawStateDatabaseCurrentReadOnly(
    ({ db }) => ({ link: readSessionUpstreamLinkInDatabase(db, sessionKey, agentId) }),
    { path: context.admission.databasePath, env: context.environment, allowNativeRead: true },
  );
  source.assertCurrent();
  if (!result) {
    throw new Error("Session upstream source is unavailable");
  }
  return result.link;
}

export function settleSessionUpstreamLink(
  expected: SessionUpstreamLink,
  settlement: SessionUpstreamSettlement,
  options: OpenClawStateDatabaseOptions & {
    assertCurrent: () => void;
  },
): Promise<boolean> {
  const context = captureOpenClawStateWorkerContext(options);
  const { assertCurrent } = options;
  const input = structuredClone({ expected, settlement });
  return runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "sessionUpstream.settle", input }),
    {
      assertCurrent,
      createAdmission: () => ({
        nativeLocations: [context.admission.databasePath],
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          if (request.stage !== "transaction" && request.stage !== "commit") {
            throw new Error("Upstream settlement requires transaction admission");
          }
          context.admission.assertCurrent();
          assertCurrent();
          grant();
        }),
      }),
    },
  );
}
