import { expect, it, vi } from "vitest";
import { callAgentToolGatewayRequest } from "../../agents/tools/in-process-gateway.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { captureSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { progressCardStore } from "../progress-card-store.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { progressCardHandlers } from "./progress-card.js";
import type { GatewayClient, RespondFn } from "./types.js";

it("commits work only through current host caller custody, never serialized operator authority", async () => {
  await withOpenClawTestState(
    { label: "progress-work-dispatch", scenario: "minimal" },
    async (state) => {
      const cfg = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const sessionKey = "agent:main:work-dispatch";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        { sessionId: "incarnation", updatedAt: 1 },
      );
      const target = captureSessionTranscriptTargetBinding({
        agentId: "main",
        sessionKey,
        sessionId: "incarnation",
        storePath: state.agentDir() + "/openclaw-agent.sqlite",
      });
      const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
      const params = {
        sessionKey,
        agentId: "main",
        plan: [{ step: "Finish", status: "pending" }],
        work: { action: "begin", scope: "Finish task" },
      };
      const client: GatewayClient = {
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: { id: "cli", version: "test", platform: "test", mode: "cli" },
          role: "operator",
          scopes: ["operator.admin"],
        },
      };
      const invoke = async (
        trusted: boolean,
        options: {
          foreign?: boolean;
          stale?: boolean;
          missingGuard?: boolean;
          fail?: boolean;
          note?: boolean;
          invalid?: boolean;
          expected?: { generation: number; revision: number };
          action?: "replace" | "reconcile";
          id?: string;
        } = {},
      ) => {
        const respond = vi.fn<RespondFn>();
        await handleGatewayRequest({
          req: {
            type: "req",
            id: "save",
            method: "progressCard.reconcileWork",
            params: options.note
              ? { sessionKey, agentId: "main", markdown: "Only a note" }
              : options.invalid
                ? { ...params, owner: {} }
                : {
                    ...params,
                    ...(options.action
                      ? {
                          work:
                            options.action === "replace"
                              ? { action: "replace", scope: "Replacement task" }
                              : { action: "reconcile" },
                        }
                      : {}),
                  },
          },
          client: trusted
            ? {
                ...client,
                internal: {
                  syntheticClient: true,
                  agentToolCaller: {
                    agentId: "main",
                    sessionKey: options.foreign ? "agent:main:foreign" : sessionKey,
                    assertCurrent() {
                      if (options.fail) {
                        throw new Error("source revoked");
                      }
                    },
                    progressWork: {
                      target,
                      expected:
                        options.expected ?? (options.note ? { generation: 1, revision: 1 } : null),
                      owner: {
                        agentId: "main",
                        sessionKey,
                        sessionId: options.stale ? "stale-incarnation" : "incarnation",
                        lifecycleRevision: null,
                      },
                      source: {
                        runId: "run",
                        turnId: "turn",
                        toolCallId: options.id ?? "save",
                        processGeneration: "process",
                      },
                    },
                  },
                },
              }
            : client,
          context,
          respond,
          isWebchatConnect: () => false,
          extraHandlers: progressCardHandlers,
          ...(trusted && !options.missingGuard ? { sessionMutationCommitGuard() {} } : {}),
        });
        return respond;
      };
      const saved = await invoke(true);
      expect(saved.mock.calls).toEqual([
        [
          true,
          expect.objectContaining({
            work: expect.objectContaining({
              kind: "retained",
              state: expect.objectContaining({ generation: 1, revision: 1 }),
            }),
          }),
          undefined,
        ],
      ]);
      const replay = await invoke(true);
      expect(replay.mock.calls).toEqual(saved.mock.calls);
      for (const options of [
        { foreign: true },
        { stale: true },
        { missingGuard: true },
        { fail: true },
        { invalid: true },
      ]) {
        const rejected = await invoke(true, options);
        expect(rejected.mock.calls[0]?.[0], JSON.stringify(options)).toBe(false);
        expect((await progressCardStore.get(sessionKey, "main"))?.steps).toEqual(params.plan);
      }
      const note = await invoke(true, { note: true });
      expect(note.mock.calls).toEqual([
        [
          true,
          {
            card: expect.objectContaining({ markdown: "Only a note" }),
            work: expect.objectContaining({
              kind: "retained",
              state: expect.objectContaining({
                generation: 1,
                revision: 1,
                record: expect.objectContaining({ steps: params.plan }),
              }),
            }),
          },
          undefined,
        ],
      ]);
      expect((await progressCardStore.get(sessionKey, "main"))?.steps).toBeUndefined();
      const remote = await invoke(false);
      expect(remote.mock.calls).toEqual([
        [false, undefined, expect.objectContaining({ code: "FORBIDDEN" })],
      ]);
      expect((await progressCardStore.get(sessionKey, "main"))?.markdown).toBe("Only a note");
      const oldFence = { generation: 1, revision: 1 };
      const replaced = await invoke(true, { action: "replace", expected: oldFence, id: "replace" });
      expect(replaced.mock.calls[0]?.[0]).toBe(true);
      const replacement = await progressCardStore.get(sessionKey, "main");
      for (const noteOnly of [false, true]) {
        const delayed = await invoke(true, {
          action: "reconcile",
          expected: oldFence,
          id: "delayed-" + noteOnly,
          note: noteOnly,
        });
        expect(delayed.mock.calls[0]?.[0]).toBe(false);
        expect(await progressCardStore.get(sessionKey, "main")).toEqual(replacement);
      }
      const concurrent = await Promise.all([
        invoke(true, {
          action: "replace",
          expected: { generation: 2, revision: 2 },
          id: "concurrent-a",
        }),
        invoke(true, {
          action: "replace",
          expected: { generation: 2, revision: 2 },
          id: "concurrent-b",
        }),
      ]);
      expect(concurrent.map((reply) => reply.mock.calls[0]?.[0])).toEqual(
        expect.arrayContaining([false, true]),
      );
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        { sessionId: "new-incarnation", updatedAt: 2 },
      );
      const afterReset = await progressCardStore.get(sessionKey, "main");
      const stale = await invoke(true, {
        action: "reconcile",
        expected: { generation: 3, revision: 3 },
        id: "after-reset",
      });
      expect(stale.mock.calls[0]?.[0]).toBe(false);
      expect(await progressCardStore.get(sessionKey, "main")).toEqual(afterReset);

      // The real in-process transport loses its acknowledgement after SQL commit.
      // There is no fallback and an explicit exact retry observes the original effect.
      const transport = await import("../call.js");
      const remoteCall = vi.spyOn(transport, "callGateway");
      let committed = false;
      const request = {
        method: "progressCard.reconcileWork",
        params: { ...params, work: { action: "replace", scope: "After reset" } },
        agentToolCaller: {
          agentId: "main",
          sessionKey,
          assertCurrent() {},
          progressWork: {
            target: { ...target, sessionId: "new-incarnation" },
            owner: {
              agentId: "main",
              sessionKey,
              sessionId: "new-incarnation",
              lifecycleRevision: null,
            },
            expected: { generation: 3, revision: 4 },
            source: {
              runId: "ack-run",
              turnId: "ack-turn",
              toolCallId: "ack-save",
              processGeneration: "process",
            },
          },
        },
        sessionMutationCommitGuard() {},
      };
      const originalBroadcast = context.broadcast;
      context.broadcast = () => {
        committed = true;
        throw new Error("acknowledgement lost");
      };
      await expect(
        withPluginRuntimeGatewayRequestScope({ context, isWebchatConnect: () => false }, () =>
          callAgentToolGatewayRequest(request),
        ),
      ).rejects.toThrow("acknowledgement lost");
      expect(committed).toBe(true);
      expect(remoteCall).not.toHaveBeenCalled();
      context.broadcast = originalBroadcast;
      const acknowledged = await withPluginRuntimeGatewayRequestScope(
        { context, isWebchatConnect: () => false },
        () => callAgentToolGatewayRequest(request),
      );
      expect(acknowledged).toMatchObject({
        work: { kind: "retained", state: { generation: 4, revision: 5 } },
      });
      await expect(callAgentToolGatewayRequest(request)).rejects.toThrow("in-process Gateway");
      expect(remoteCall).not.toHaveBeenCalled();
      remoteCall.mockRestore();
    },
  );
});
