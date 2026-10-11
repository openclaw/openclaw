import path from "node:path";
import { expect, it, vi } from "vitest";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { createSubagentRunRecord } from "../../agents/subagent-test-fixtures.test-helpers.js";
import "../../agents/subagents/registry/subagent-registry-maintenance.js";
import {
  persistRegistryFixture,
  saveSubagentRegistryToSqlite,
} from "../../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { clearSubagentRunsReadCacheForTest } from "../../agents/subagents/registry/subagent-registry-state.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as backoff from "../../infra/backoff.js";
import * as stateReads from "../../state/openclaw-state-db-readonly.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import { getReplyFromConfig } from "./get-reply.js";
import { finalizeInboundContext } from "./inbound-context.js";

vi.mock("../../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/embedded-agent.js")>()),
  runEmbeddedAgent: vi.fn(async () => ({
    payloads: [{ text: "Instruction received" }],
    meta: { durationMs: 1 },
  })),
}));

vi.mock(
  "../../config/sessions/session-accessor.sqlite-maintenance-kick.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../config/sessions/session-accessor.sqlite-maintenance-kick.js")
    >()),
    kickSessionEntryMaintenanceAfterWrite: vi.fn(),
  }),
);

it.each([2, Infinity])(
  "re-prepares changed subagent facts before dispatching the user turn (conflicts: %s)",
  async (conflicts) => {
    await withOpenClawTestState(
      {
        scenario: "minimal",
        env: { OPENCLAW_TEST_FAST: "0", OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" },
      },
      async (state) => {
        const sessionKey = "agent:main:dashboard:maintenance-conflict";
        const storePath = path.join(state.sessionsDir(), "sessions.json");
        const cfg = withFullRuntimeReplyConfig({
          agents: {
            defaults: {
              workspace: state.workspaceDir,
              skipBootstrap: true,
              model: { primary: "mock-openai/gpt-5.6-luna" },
              models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
            },
          },
          plugins: { enabled: false },
          skills: { load: { watch: false } },
          session: { store: storePath },
        });
        await state.writeConfig(cfg);
        await upsertSessionEntryCore(
          { sessionKey, storePath },
          { sessionId: "accepted-input", updatedAt: Date.now() },
        );
        clearSubagentRunsReadCacheForTest();
        vi.mocked(runEmbeddedAgent).mockClear();
        const child = createSubagentRunRecord({
          runId: "recovering-child",
          requesterSessionKey: sessionKey,
          childSessionKey: "agent:main:subagent:recovering-child",
        });
        saveSubagentRegistryToSqlite(new Map([[child.runId, child]]));
        const read = stateReads.executeExistingOpenClawStateRead;
        let preparations = 0;
        const reads = vi
          .spyOn(stateReads, "executeExistingOpenClawStateRead")
          .mockImplementation(async (...args) => {
            const reply = await read(...args);
            if (args[1].type === "subagents.runs" && args[1].scope.kind === "maintenance") {
              preparations += 1;
              if (preparations <= conflicts) {
                persistRegistryFixture(
                  new Map([[child.runId, { ...child, cleanupCompletedAt: preparations }]]),
                  [child.runId],
                );
              }
            }
            return reply;
          });
        const sleep = vi.spyOn(backoff, "sleepWithAbort").mockResolvedValue();
        try {
          const body = "Take over the unfinished work too";
          const dispatch = getReplyFromConfig(
            finalizeInboundContext({
              Body: body,
              RawBody: body,
              BodyForAgent: body,
              CommandBody: body,
              CommandAuthorized: true,
              Provider: "webchat",
              Surface: "webchat",
              ChatType: "direct",
              SessionKey: sessionKey,
              ThreadLabel: "accepted instruction",
            }),
            undefined,
            cfg,
          );
          if (conflicts === Infinity) {
            await expect(dispatch).rejects.toThrow(/retry your message/i);
            expect(preparations).toBe(5);
            expect(sleep).toHaveBeenCalledTimes(4);
            expect(runEmbeddedAgent).not.toHaveBeenCalled();
            expect(loadSessionEntry({ sessionKey, storePath })?.displayName).toBeUndefined();
          } else {
            expect([await dispatch].flat()).toEqual([
              expect.objectContaining({ text: "Instruction received" }),
            ]);
            expect(runEmbeddedAgent).toHaveBeenCalledOnce();
            expect(vi.mocked(runEmbeddedAgent).mock.calls[0]![0]).toMatchObject({
              sessionId: "accepted-input",
              prompt: expect.stringContaining(body),
            });
            expect(preparations).toBe(3);
            expect(sleep).toHaveBeenCalledTimes(2);
            expect(loadSessionEntry({ sessionKey, storePath })?.displayName).toBe(
              "accepted instruction",
            );
          }
        } finally {
          reads.mockRestore();
          sleep.mockRestore();
          clearSubagentRunsReadCacheForTest();
        }
      },
    );
  },
);
