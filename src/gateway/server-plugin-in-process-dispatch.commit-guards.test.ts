import { expect, it } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { callAgentToolGatewayRequest } from "../agents/tools/in-process-gateway.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getOperatorApprovalDetailed, insertOperatorApproval } from "./operator-approval-store.js";
import { createApprovalRequestAuthority } from "./server-methods/approval-request-authority.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { dispatchGatewayMethodInProcess } from "./server-plugin-in-process-dispatch.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";

function dispatch(method: string, scope: string, params = {}, guard = () => {}) {
  return dispatchGatewayMethodInProcess(method, params, {
    forceSyntheticClient: true,
    syntheticScopes: [scope],
    sessionMutationCommitGuard: guard,
  });
}

async function withoutHostMutation<T>(pattern: RegExp, run: () => Promise<T>): Promise<T> {
  const sql = observeHostDataSql();
  try {
    return await run();
  } finally {
    sql.restore();
    expect(sql.queries.filter((query) => pattern.test(query))).toEqual([]);
  }
}

it.each(["runtime", "legacy"] as const)(
  "routes %s approval expiry through its worker with the request guard",
  (entrypoint) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      await insertOperatorApproval({
        approval: {
          id: "expiry",
          kind: "exec",
          runtimeEpoch: "fixture",
          createdAtMs: 1,
          expiresAtMs: 2,
          presentation: {
            kind: "exec",
            commandText: "echo fixture",
            allowedDecisions: ["allow-once", "deny"],
          },
        },
      });
      const handler = async (options: GatewayRequestHandlerOptions) => {
        using authority = createApprovalRequestAuthority(options);
        const result = await withoutHostMutation(/^update "operator_approvals" set\b/i, () =>
          getOperatorApprovalDetailed({ id: "expiry", nowMs: 3, guard: authority.guard }),
        );
        options.respond(true, result);
      };
      const context = createContext([["approval.get", "operator.approvals", "approvals", handler]]);
      const result = await withPluginRuntimeGatewayRequestScope(
        {
          context,
          isWebchatConnect: () => false,
          pluginId: "approval-fixture",
          pluginOrigin: "bundled",
        },
        () =>
          entrypoint === "runtime"
            ? createPluginRuntime().gateway.request(
                "approval.get",
                {},
                { scopes: ["operator.admin"] },
              )
            : dispatch("approval.get", "operator.admin"),
      );
      expect(result).toMatchObject({ outcome: "found", record: { status: "expired" } });
    }),
);

it.each(["direct", "tool"] as const)(
  "keeps opaque and prepared commit guards authoritative with worker writes on %s dispatch",
  (entrypoint) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      const scope = { agentId: "main", sessionKey: "agent:main:commit-guard-routing" };
      await upsertSessionEntryCore(scope, { sessionId: "guard-routing-session", updatedAt: 1 });
      for (const kind of ["opaque", "prepared"] as const) {
        let current = true;
        let revokeDuringUpdate = false;
        const assertCurrent = () => {
          if (!current) {
            throw new Error("session commit authority revoked");
          }
        };
        const guard =
          kind === "prepared"
            ? Object.assign(assertCurrent, {
                prepareSessionSource: async () => ({ assertCurrent, checks: [] }),
              })
            : assertCurrent;
        const handler = async (options: GatewayRequestHandlerOptions) => {
          const update = () => {
            current = !revokeDuringUpdate;
            return { label: revokeDuringUpdate ? "must not persist" : kind };
          };
          const entry = await withoutHostMutation(
            /^(?:update "session_nodes" set\b|insert into "session_nodes"\s)/i,
            () =>
              patchSessionEntryCore(scope, update, {
                workerGuard: { source: options.sessionMutationCommitGuard },
              }),
          );
          options.respond(true, { label: entry?.label });
        };
        const context = createContext([["sessions.create", "operator.write", "sessions", handler]]);
        const invoke = () =>
          withPluginRuntimeGatewayRequestScope({ context, isWebchatConnect: () => false }, () =>
            entrypoint === "tool"
              ? callAgentToolGatewayRequest({
                  method: "sessions.create",
                  params: { agentId: "main" },
                  assertDispatchCurrent: () => {},
                  sessionMutationCommitGuard: guard,
                })
              : dispatch("sessions.create", "operator.write", { agentId: "main" }, guard),
          );
        await expect(invoke()).resolves.toEqual({ label: kind });
        revokeDuringUpdate = true;
        await expect(invoke()).rejects.toThrow("session commit authority revoked");
        expect(await readSessionEntryReadOnlyInWorker(scope)).toMatchObject({ label: kind });
      }
    }),
);
