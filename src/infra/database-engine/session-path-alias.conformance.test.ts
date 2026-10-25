import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, vi } from "vitest";
import type { executeAgentTurn } from "../../auto-reply/reply/agent-runner-execution.js";
import { withFullRuntimeReplyConfig } from "../../auto-reply/reply/get-reply-fast-path.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { listSessionPendingInputs } from "../../config/sessions/session-accessor.pending-inputs.js";
import { readSessionEntryInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDirectChatContext } from "../../gateway/server-chat.agent-events.test-helpers.js";
import { successfulChatTurn } from "../../gateway/server-methods/chat-send-authority.test-support.js";
import { handleChatSend } from "../../gateway/server-methods/chat-send-handler.js";
import type { GatewayClient, RespondFn } from "../../gateway/server-methods/types.js";
import { disposeSessionReadContexts } from "../../gateway/session-read-contexts.test-support.js";
import { createWorkerSessionPlacementStore } from "../../gateway/worker-environments/placement-store.js";
import { loadOrCreateProcessDeviceIdentityAsync } from "../../infra/device-identity-async.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

const runtime = vi.hoisted(() => ({ execute: vi.fn<typeof executeAgentTurn>() }));

// Keep chat admission, dispatch, actor custody, and transcript persistence real.
vi.mock("../../auto-reply/reply/agent-runner-execution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../auto-reply/reply/agent-runner-execution.js")>()),
  executeAgentTurn: runtime.execute,
}));

for (const engine of ["sqlite", "postgres"] as const) {
  describe.skipIf(engine === "postgres" && !mixedAgentConnection)(
    `${engine} agent store through a state directory alias`,
    () => {
      // Cover agent-store ownership while shared-state plugin discovery stays on SQLite.
      const pair = useMixedAgentPair("sqlite", engine);

      it("completes first chat and persists its admitted input", async () => {
        const physicalState = fs.realpathSync.native(pair.root);
        const stateAlias = path.join(pair.root, "state-alias");
        fs.symlinkSync(
          physicalState,
          stateAlias,
          process.platform === "win32" ? "junction" : "dir",
        );
        vi.stubEnv("OPENCLAW_STATE_DIR", stateAlias);
        const config: OpenClawConfig = withFullRuntimeReplyConfig({
          ...JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH!, "utf8")),
          agents: {
            defaults: {
              model: { primary: "openai/gpt-4.1-mini" },
              skipBootstrap: true,
            },
            entries: { main: { workspace: path.join(physicalState, "workspace") } },
          },
          plugins: { enabled: false },
        });
        fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH!, JSON.stringify(config));
        setRuntimeConfigSnapshot(config, config);
        await loadOrCreateProcessDeviceIdentityAsync();
        const stateDatabase = withEngineStoreAdmission(() => openOpenClawStateDatabase());
        // Gateway startup admits the database before the first chat creates a session.
        withEngineStoreAdmission(() => openOpenClawAgentDatabase({ agentId: "main" }));
        const scope = {
          agentId: "main",
          sessionKey: "agent:main:main",
          storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
        };
        const context = createDirectChatContext({
          getRuntimeConfig: () => config,
          workerSessionPlacementService: createWorkerSessionPlacementStore({
            database: stateDatabase,
          }),
        });
        const client: GatewayClient = {
          connId: "state-alias-client",
          connect: {
            minProtocol: 1,
            maxProtocol: 1,
            role: "operator",
            scopes: ["operator.read", "operator.write", "operator.admin"],
            client: {
              id: "openclaw-control-ui",
              version: "test",
              platform: "web",
              mode: "webchat",
            },
          },
        };
        const params = {
          sessionKey: scope.sessionKey,
          message: "Persist this input through the state directory alias.",
          idempotencyKey: randomUUID(),
        };
        let source: ReturnType<typeof rpcSourceTesting.get>;
        const respond = vi.fn<RespondFn>((ok) => {
          if (ok) {
            source = rpcSourceTesting.get(params.idempotencyKey);
          }
        });
        runtime.execute.mockReset();
        runtime.execute.mockImplementation(async ({ followupRun, opts }) => {
          const runId = expectDefined(opts?.runId, "admitted run ID");
          opts?.onAgentRunStart?.(runId);
          const recorder = expectDefined(followupRun.userTurnTranscriptRecorder, "input recorder");
          await recorder.persistApproved();
          return successfulChatTurn(runId, "The input was saved.");
        });
        try {
          await withPluginRuntimeGatewayRequestScope(
            { context, isWebchatConnect: () => true },
            () =>
              handleChatSend({
                req: { type: "req", id: params.idempotencyKey, method: "chat.send", params },
                params,
                client,
                context,
                respond,
                isWebchatConnect: () => true,
              }),
          );
          expect(respond.mock.calls[0]?.[0]).toBe(true);
          expect(respond.mock.calls[0]?.[1]).toMatchObject({
            runId: params.idempotencyKey,
            status: "started",
          });
          await expectDefined(source, "acknowledged chat source").input.settlement.promise;
          expect(context.broadcast).toHaveBeenCalledWith(
            "chat",
            expect.objectContaining({ runId: params.idempotencyKey, state: "final" }),
            expect.anything(),
          );
          expect(runtime.execute).toHaveBeenCalledOnce();
          const entry = expectDefined(await readSessionEntryInWorker(scope), "created session");
          const createdScope = { ...scope, sessionId: entry.sessionId };
          expect(await loadTranscriptEvents(createdScope)).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                message: expect.objectContaining({ role: "user", content: params.message }),
              }),
            ]),
          );
          expect(await listSessionPendingInputs(createdScope)).toMatchObject({ total: 0 });
        } finally {
          try {
            await source?.input.settlement.promise;
          } finally {
            await disposeSessionReadContexts();
            await cleanupSessionStateForTest({ stateDir: stateAlias });
          }
        }
      });
    },
  );
}
