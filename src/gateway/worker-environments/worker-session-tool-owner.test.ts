import "./worker-session-tool-executor.test-support.js";
import { describe, expect, it, vi } from "vitest";
import * as sendTool from "../../agents/tools/sessions-send-tool.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as lookup from "../session-utils-store-worker.js";

const { createWorkerSessionToolTestFixture, SOURCE, workerSessionToolTestMocks } =
  await import("./worker-session-tool-executor.test-support.js");

const realLookup = await vi.importActual<typeof lookup>("../session-utils-store-worker.js");
const realSendTool = await vi.importActual<typeof sendTool>(
  "../../agents/tools/sessions-send-tool.js",
);

describe.each([false, true])("worker family ownership (shared store=%s)", (shared) => {
  const source = {
    ...SOURCE,
    agentId: shared ? "worker" : "ops",
    sessionKey: `agent:${shared ? "worker" : "ops"}:dashboard:child`,
  };
  const mocks = workerSessionToolTestMocks();

  it("sends to the non-default global parent and sibling through the core tool", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const fixture = await createWorkerSessionToolTestFixture(mocks, { sourceSession: source });
      const lookupSpy = vi
        .spyOn(lookup, "resolveGatewaySessionStoreTargetInWorker")
        .mockImplementation(realLookup.resolveGatewaySessionStoreTargetInWorker);
      const sendSpy = vi
        .spyOn(sendTool, "createSessionsSendTool")
        .mockImplementation(realSendTool.createSessionsSendTool);
      try {
        const cfg: OpenClawConfig = {
          session: {
            scope: "global",
            ...(shared ? { store: state.statePath("shared.sqlite") } : {}),
          },
          agents: {
            entries: { main: {}, ops: {}, worker: {} },
            ...(shared ? { defaults: { sessionStore: { agentId: "ops" } } } : {}),
          },
          tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
        };
        setRuntimeConfigSnapshot(cfg);
        const parent = { sessionKey: "global", sessionId: "ops-parent" };
        const sibling = { sessionKey: "agent:ops:dashboard:sibling", sessionId: "ops-sibling" };
        const { setEntry, send } = fixture;
        setEntry(source.sessionKey, source.sessionId, parent);
        for (const target of [source, sibling]) {
          await replaceSessionEntry(
            {
              agentId: target === source ? source.agentId : "ops",
              sessionKey: target.sessionKey,
              storePath: cfg.session?.store,
            },
            {
              sessionId: target.sessionId,
              updatedAt: 1,
              parentSessionKey: "global",
              parentSessionId: parent.sessionId,
            },
          );
        }
        await replaceSessionEntry(
          { agentId: "ops", sessionKey: "global", storePath: cfg.session?.store },
          { sessionId: parent.sessionId, updatedAt: 1 },
        );
        if (!shared) {
          await replaceSessionEntry(
            { agentId: "main", sessionKey: "global" },
            { sessionId: "unrelated-main-parent", updatedAt: 1 },
          );
        }
        const delivered: Array<{ agentId: string; sessionKey: string }> = [];
        mocks.gatewayRequest.mockImplementation(async (request) => {
          if (request.method === "sessions.resolve") {
            const target = await realLookup.resolveGatewaySessionStoreTargetInWorker({
              cfg,
              key: request.params.key,
              agentId: request.params.agentId,
            });
            return { key: target.canonicalKey, agentId: target.agentId };
          }
          if (request.method === "agent") {
            request.sessionMutationCommitGuard?.();
            delivered.push({
              agentId: request.params.agentId,
              sessionKey: request.params.sessionKey,
            });
            return { runId: request.params.idempotencyKey, status: "accepted" };
          }
          throw new Error(`Unexpected Gateway method: ${request.method}`);
        });
        for (const target of [parent, sibling]) {
          const result = await send(`send-${target.sessionId}`, { sessionKey: target.sessionKey });
          expect.soft(JSON.parse(result.resultJson), result.resultJson).toMatchObject({
            details: { status: "accepted" },
          });
        }
        expect(delivered).toEqual([
          { agentId: "ops", sessionKey: "global" },
          { agentId: "ops", sessionKey: sibling.sessionKey },
        ]);
      } finally {
        lookupSpy.mockRestore();
        sendSpy.mockRestore();
        await fixture.dispose();
      }
    });
  });
});
