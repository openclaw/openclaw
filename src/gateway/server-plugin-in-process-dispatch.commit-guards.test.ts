import { expect, it } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { callAgentToolGatewayRequest } from "../agents/tools/in-process-gateway.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { getOperatorApprovalDetailed, insertOperatorApproval } from "./operator-approval-store.js";
import { createApprovalRequestAuthority } from "./server-methods/approval-request-authority.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { dispatchGatewayMethodInProcess } from "./server-plugin-in-process-dispatch.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";

it.each(["runtime", "legacy"] as const)(
  "routes %s approval expiry through its worker or released native guard contract",
  async (entrypoint) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await insertOperatorApproval({
        approval: {
          id: "approval-expiry-routing",
          kind: "exec",
          runtimeEpoch: "fixture",
          createdAtMs: 1,
          expiresAtMs: 2,
          presentation: {
            kind: "exec",
            commandText: "echo fixture",
            commandPreview: "echo fixture",
            warningText: null,
            host: "gateway",
            nodeId: null,
            agentId: null,
            allowedDecisions: ["allow-once", "deny"],
          },
        },
      });
      const context = createContext();
      let nativeMutation = false;
      context.getGatewayMethodRegistry = () =>
        createGatewayMethodRegistry([
          {
            name: "approval.get",
            scope: "operator.approvals",
            owner: { kind: "core", area: "approvals" },
            handler: async (options: GatewayRequestHandlerOptions) => {
              using authority = createApprovalRequestAuthority(options);
              const sql = observeHostDataSql();
              try {
                const result = await getOperatorApprovalDetailed({
                  id: "approval-expiry-routing",
                  nowMs: 3,
                  guard: authority.guard,
                });
                nativeMutation = sql.queries.some((query) =>
                  /^update "operator_approvals" set\b/i.test(query),
                );
                options.respond(true, result);
              } finally {
                sql.restore();
              }
            },
          },
        ]);
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
            : dispatchGatewayMethodInProcess(
                "approval.get",
                {},
                {
                  forceSyntheticClient: true,
                  syntheticScopes: ["operator.admin"],
                  sessionMutationCommitGuard: () => {},
                },
              ),
      );
      expect(result).toMatchObject({ outcome: "found", record: { status: "expired" } });
      expect(nativeMutation).toBe(entrypoint === "legacy");
    });
  },
);

it.each(["direct", "tool"] as const)(
  "keeps opaque and prepared commit guards authoritative with worker writes on %s dispatch",
  async (entrypoint) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = { agentId: "main", sessionKey: "agent:main:commit-guard-routing" };
      await upsertSessionEntryCore(scope, { sessionId: "guard-routing-session", updatedAt: 1 });
      const context = createContext();
      for (const kind of ["opaque", "prepared"] as const) {
        let current = true;
        let revokeDuringUpdate = false;
        const assertHostCurrent = () => {
          if (!current) {
            throw new Error("session commit authority revoked");
          }
        };
        const guard =
          kind === "prepared"
            ? Object.assign(assertHostCurrent, {
                prepareSessionSource: async () => ({
                  assertCurrent: assertHostCurrent,
                  checks: [],
                }),
              })
            : assertHostCurrent;
        let nativeMutation = false;
        context.getGatewayMethodRegistry = () =>
          createGatewayMethodRegistry([
            {
              name: "sessions.create",
              scope: "operator.write",
              owner: { kind: "core", area: "sessions" },
              handler: async ({
                respond,
                sessionMutationCommitGuard,
              }: GatewayRequestHandlerOptions) => {
                const sql = observeHostDataSql();
                try {
                  const entry = await patchSessionEntryCore(
                    scope,
                    () => {
                      current = !revokeDuringUpdate;
                      return { label: revokeDuringUpdate ? "must not persist" : kind };
                    },
                    { workerGuard: { source: sessionMutationCommitGuard } },
                  );
                  respond(true, { label: entry?.label });
                } finally {
                  nativeMutation = sql.queries.some((query) =>
                    /^(?:update "session_nodes" set\b|insert into "session_nodes"\s)/i.test(query),
                  );
                  sql.restore();
                }
              },
            },
          ]);
        const invoke = () =>
          withPluginRuntimeGatewayRequestScope({ context, isWebchatConnect: () => false }, () =>
            entrypoint === "tool"
              ? callAgentToolGatewayRequest({
                  method: "sessions.create",
                  params: { agentId: "main" },
                  assertDispatchCurrent: () => {},
                  sessionMutationCommitGuard: guard,
                })
              : dispatchGatewayMethodInProcess(
                  "sessions.create",
                  { agentId: "main" },
                  {
                    forceSyntheticClient: true,
                    syntheticScopes: ["operator.write"],
                    sessionMutationCommitGuard: guard,
                  },
                ),
          );
        await expect(invoke()).resolves.toEqual({ label: kind });
        expect(nativeMutation).toBe(false);
        revokeDuringUpdate = true;
        await expect(invoke()).rejects.toThrow("session commit authority revoked");
        expect(nativeMutation).toBe(false);
        expect(await readSessionEntryReadOnlyInWorker(scope)).toMatchObject({ label: kind });
      }
    });
  },
);
