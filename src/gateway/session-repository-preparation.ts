import { ok } from "@openclaw/normalization-core/result";
import type { SessionsCreateParams } from "../../packages/gateway-protocol/src/index.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import type {
  PrepareGatewaySessionLifecycle,
  PreparedGatewaySessionLifecycle,
} from "./session-create-service.types.js";
import { invalidSessionRequest } from "./session-request-error.js";

export function prepareSessionRepositoryWorkspace(
  repository: NonNullable<SessionsCreateParams["repository"]>,
  options: {
    runSetupScript: boolean;
    branchPrefix?: string;
    assertCurrent: SessionSourceAssertion;
  },
): PrepareGatewaySessionLifecycle {
  const { assertCurrent } = options;
  return async (target) => {
    const store = getSessionRepositoryWorkspaceStore();
    const source = captureOpenClawStateWorkerContext({ path: store.path });
    const assertSourceCurrent = composeSessionSourceAssertion([assertCurrent], (assertSources) => {
      source.admission.assertCurrent();
      assertSources();
    });
    const existing = await store.find({ agentId: target.agentId, sessionKey: target.key });
    if (
      target.entry &&
      (!target.entry.repositoryWorkspaceId ||
        target.entry.repositoryWorkspaceId !== existing?.workspaceId)
    ) {
      return invalidSessionRequest("repository source requires a new repository session");
    }
    if (
      existing &&
      (existing.url !== repository.url || existing.requestedRef !== (repository.ref ?? null))
    ) {
      return invalidSessionRequest("session repository source cannot be changed");
    }
    assertSourceCurrent();
    const workspace = await store.create({
      agentId: target.agentId,
      sessionKey: target.key,
      url: repository.url,
      requestedRef: repository.ref,
      runSetupScript: options.runSetupScript,
      branchPrefix: options.branchPrefix,
      assertCurrent: assertSourceCurrent,
    });
    const withCommit: NonNullable<PreparedGatewaySessionLifecycle["withCommit"]> = (run) =>
      runOpenClawStateWorkerOperation(source, () => run(assertSourceCurrent), {
        assertCurrent: assertSourceCurrent,
      });
    return ok({
      repositoryWorkspaceId: workspace.workspaceId,
      withCommit,
      ...(!existing
        ? {
            rollback: async () => {
              // Creation still holds the session lifecycle lock. Cleanup owns only the
              // untouched row it allocated, even when the initiating caller has gone away.
              source.admission.assertCurrent();
              const prepared = await store.prepare(workspace.workspaceId);
              await store.delete({
                workspaceId: workspace.workspaceId,
                assertCurrent: () => {
                  source.admission.assertCurrent();
                  const current = prepared.current();
                  if (
                    current &&
                    (current.agentId !== target.agentId ||
                      current.sessionKey !== target.key ||
                      current.revision !== workspace.revision)
                  ) {
                    throw new Error("Repository preparation changed before rollback");
                  }
                },
              });
            },
          }
        : {}),
    });
  };
}
