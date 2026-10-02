// Public session creation/read, real plugin invocation, durable outbox, and Gateway admission.
import { describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import {
  holdExecution,
  installAgentAuthorityProofFixture,
} from "./server.agent-runtime-authority-proof.test-support.js";

describe("durable plugin callback Gateway admission", () => {
  const fixture = installAgentAuthorityProofFixture();

  it.for(["current", "replaced", "lifecycle-reset"] as const)(
    "checks callback admission for a publicly created non-main session: %s child",
    async (mode, { signal }) => {
      const f = await fixture({ publicSession: true });
      const { registerSubagentRun } =
        await import("../agents/subagents/registry/subagent-registry.js");
      const { subagentRuns } =
        await import("../agents/subagents/registry/subagent-registry-memory.js");
      const { markSubagentRunPausedAfterYield } =
        await import("../agents/subagents/registry/subagent-registry-run-pause.js");
      const { loadSubagentRegistryFromSqlite } =
        await import("../agents/subagents/registry/subagent-registry.store.sqlite.js");
      const { mutateSubagentRuns } =
        await import("../agents/subagents/registry/subagent-registry-persistence.js");
      const { registerAgentRunContext, clearAgentRunContext } =
        await import("../infra/agent-run-registry.js");
      const { createPluginRegistry } = await import("../plugins/registry.js");
      const { createPluginRecord } = await import("../plugins/status.test-helpers.js");
      const { createPluginRuntimeMock } =
        await import("../plugin-sdk/test-helpers/plugin-runtime-mock.js");
      const { createPluginToolFactoryContext } = await import("../plugins/tool-factory-context.js");
      const { bindPluginToolCallbacks } = await import("../plugins/tool-factory-runtime.js");
      const { captureOpenClawStateWorkerContext } =
        await import("../state/openclaw-state-worker-context.js");
      const { loadPendingSessionDeliveries } =
        await import("../infra/session-delivery-queue-storage.js");
      const { deliverNativeChildCallback } = await import("./session-plugin-callback-delivery.js");
      const admission = await import("./agent-turn/agent-run-subagent.js");
      const priorRunId = `callback-origin:${f.runId}`;
      await registerSubagentRun({
        runId: priorRunId,
        childSessionKey: f.sessionKey,
        requesterSessionKey: "agent:main:main",
        controllerSessionKey: "agent:main:main",
        requesterDisplayKey: "agent:main:main",
        task: "Wait for plugin result",
        cleanup: "keep",
        expectsCompletionMessage: true,
        queued: true,
        sessionEntry: sessionAccessor.loadSessionEntry(f.scope),
      });
      const updateChild = (update: (draft: SubagentRunRecord) => void) =>
        mutateSubagentRuns([priorRunId], (rows) => {
          const draft = structuredClone(rows.get(priorRunId)!);
          update(draft);
          return { value: undefined, postimages: new Map([[priorRunId, draft]]) };
        });
      await updateChild((draft) => {
        draft.execution.status = "running";
      });
      registerAgentRunContext(priorRunId, {
        agentId: "main",
        sessionKey: f.sessionKey,
        sessionId: f.sessionId,
      });
      const builder = createPluginRegistry({
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        runtime: createPluginRuntimeMock(),
        activateGlobalSideEffects: false,
      });
      const record = createPluginRecord({
        id: "callback-proof",
        contracts: { tools: ["callback_probe"] },
      });
      builder.registry.plugins.push(record);
      const api = builder.createApi(record, { config: {}, registrationMode: "full" });
      let token = "";
      api.registerTool(
        {
          contextVersion: 2,
          create: (ctx) => ({
            name: "callback_probe",
            label: "Callback probe",
            description: "Wait for a remote result",
            parameters: { type: "object", properties: {} },
            execute: async () => {
              token = (await ctx.issueAsyncCallback!({ ttlMs: 60_000 })).token;
              return { content: [{ type: "text" as const, text: "pending" }], details: {} };
            },
          }),
        },
        { name: "callback_probe" },
      );
      const entry = builder.registry.tools[0]!;
      const ctx = createPluginToolFactoryContext({
        entry,
        registry: builder.registry,
        runId: priorRunId,
        context: { agentId: "main", sessionKey: f.sessionKey, sessionId: f.sessionId },
        assertInvocationCurrent: () => {},
      });
      const tool = entry.factory(ctx);
      if (!tool || Array.isArray(tool)) {
        throw new Error("missing callback proof tool");
      }
      const execution = await holdExecution(signal);
      const prepare = admission.prepareGatewaySubagentRun;
      const observer = vi
        .spyOn(admission, "prepareGatewaySubagentRun")
        .mockImplementationOnce(async (params) => {
          const prepared = await prepare(params);
          expect(prepared.adoptParentResume).toBeTypeOf("function");
          // Change authority after the real owner prepared adoption, before the
          // registered agent handler performs its final revalidation and commit.
          if (mode === "replaced") {
            await updateChild((draft) => {
              draft.generation = (draft.generation ?? 0) + 1;
            });
          } else if (mode === "lifecycle-reset") {
            await sessionAccessor.replaceSessionEntry(f.scope, {
              ...sessionAccessor.loadSessionEntry(f.scope)!,
              lifecycleRevision: "callback-reset-lifecycle",
            });
          }
          return prepared;
        });
      try {
        await bindPluginToolCallbacks(
          entry,
          builder.registry,
          tool,
          ctx.assertInvocationCurrent,
        ).execute("issue", {});
        expect(token).not.toBe("");
        await updateChild((draft) => {
          expect(markSubagentRunPausedAfterYield({ entry: draft })).toBe(true);
        });
        expect(await api.asyncToolCallbacks.complete({ token, resultText: "remote result" })).toBe(
          "accepted",
        );
        const queueContext = captureOpenClawStateWorkerContext();
        const queued = (await loadPendingSessionDeliveries(queueContext)).find(
          (row) =>
            row.kind === "nativeChildFollowup" &&
            row.sessionKey === f.sessionKey &&
            !row.callbackExpiryKey,
        );
        if (queued?.kind !== "nativeChildFollowup") {
          throw new Error("missing durable callback outbox");
        }
        const successor = `plugin-callback:${queued.id}`;
        const request = deliverNativeChildCallback({
          entry: queued,
          queueContext,
          resolveGatewayContext: () => f.context,
        });
        if (mode !== "current") {
          await expect(request).rejects.toThrow(
            mode === "replaced"
              ? /cancelled, replaced, or settled/
              : /lifecycle|no longer|changed/i,
          );
          expect(subagentRuns.has(successor)).toBe(false);
          expect(loadSubagentRegistryFromSqlite().has(successor)).toBe(false);
          expect(execution.observer).not.toHaveBeenCalled();
          expect(sessionAccessor.loadTranscriptEventsSync(f.scope)).toEqual(f.before);
        } else {
          await request;
          expect(loadSubagentRegistryFromSqlite().get(successor)).toMatchObject({
            taskRunId: priorRunId,
            requesterSessionKey: "agent:main:main",
          });
          await deliverNativeChildCallback({
            entry: queued,
            queueContext,
            resolveGatewayContext: () => f.context,
          });
          expect(execution.observer).toHaveBeenCalledTimes(1);
        }
        expect(observer).toHaveBeenCalledTimes(1);
      } finally {
        observer.mockRestore();
        clearAgentRunContext(priorRunId);
        await execution.cleanup();
        await f.cleanup();
      }
    },
  );
});
