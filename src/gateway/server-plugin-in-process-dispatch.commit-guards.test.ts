import { expect, it } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { callAgentToolGatewayRequest } from "../agents/tools/in-process-gateway.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { dispatchGatewayMethodInProcess } from "./server-plugin-in-process-dispatch.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";

it.each(["direct", "tool"] as const)(
  "keeps opaque commit guards native without pinning prepared host guards on %s dispatch",
  async (entrypoint) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = { agentId: "main", sessionKey: "agent:main:commit-guard-routing" };
      await upsertSessionEntryCore(scope, { sessionId: "guard-routing-session", updatedAt: 1 });
      const context = createContext();
      for (const kind of ["opaque", "prepared"] as const) {
        const assertHostCurrent = () => {};
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
                  const entry = await patchSessionEntryCore(scope, () => ({ label: kind }), {
                    workerGuard: { source: sessionMutationCommitGuard },
                  });
                  // The canonical writer (#167932) upserts session rows natively.
                  nativeMutation = sql.queries.some((query) =>
                    /^(?:update "session_nodes" set\b|insert into "session_nodes"\s)/i.test(query),
                  );
                  respond(true, { label: entry?.label });
                } finally {
                  sql.restore();
                }
              },
            },
          ]);
        const result = await withPluginRuntimeGatewayRequestScope(
          { context, isWebchatConnect: () => false },
          () =>
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
        expect(result).toEqual({ label: kind });
        expect(nativeMutation).toBe(kind === "opaque");
      }
    });
  },
);
