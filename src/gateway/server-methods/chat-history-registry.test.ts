import { expect, it, vi } from "vitest";
import { saveSubagentRegistryToSqlite } from "../../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { clearSubagentRunsReadCacheForTest } from "../../agents/subagents/registry/subagent-registry-state.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as sharingPreparation from "../session-sharing-preparation.js";
import {
  expectHistoryError,
  expectHistoryPayload,
  historyPayload,
  historyRpc,
  withHistoryState,
} from "./chat-history-fixture.test-support.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";

it.each(["catalog publication", "session creation"] as const)(
  "checks an absent history's identity across %s during preparation",
  async (change) => {
    await withHistoryState(async () => {
      setRuntimeConfigSnapshot({});
      const context = await createHistoryReadContext();
      const scope = { agentId: "main", sessionKey: "agent:main:created-mid-read" };
      const prepare = sharingPreparation.prepareSessionMutationFacts;
      using probe = vi.spyOn(sharingPreparation, "prepareSessionMutationFacts");
      if (change === "session creation") {
        probe.mockImplementationOnce(async (params) => {
          await upsertSessionEntryCore(scope, { sessionId: "created-mid-read", updatedAt: 1 });
          return await prepare(params);
        });
      } else {
        probe.mockImplementation(async (params) => {
          try {
            return await prepare(params);
          } finally {
            sessionChanges.emit({ all: true, scope: "catalog" });
          }
        });
      }
      const respond = await historyRpc(context, scope.sessionKey)("chat.history");
      if (change === "session creation") {
        expectHistoryError(respond, { code: "UNAVAILABLE", retryable: true });
      } else {
        expectHistoryPayload(respond, { messages: [], sessionId: undefined });
      }
    });
  },
);

it.each(["global", "per-sender"] as const)(
  "reads the selected agent's %s main alias before a competing literal row",
  async (sessionScope) => {
    await withHistoryState(async (state) => {
      const cfg = {
        agents: { ownership: "explicit", entries: { main: {}, work: {} } },
        session: { scope: sessionScope, mainKey: "home" },
      } satisfies OpenClawConfig;
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      for (const agentId of ["main", "work"]) {
        const selectedKey = sessionScope === "global" ? "global" : `agent:${agentId}:home`;
        for (const kind of ["selected", "literal"]) {
          const sessionKey = kind === "literal" ? `agent:${agentId}:main` : selectedKey;
          const content = `${kind === "selected" ? "Selected" : "Literal"} ${agentId} history`;
          const scope = { agentId, sessionKey, sessionId: `${kind}-history-${agentId}` };
          const entry = { sessionId: scope.sessionId, updatedAt: 1 };
          if (kind === "literal") {
            replaceSessionEntrySync(scope, entry);
          } else {
            await upsertSessionEntryCore(scope, entry);
          }
          await appendTranscriptMessage(scope, {
            message: { role: "user", content },
            now: 1,
          });
        }
      }
      const context = await createHistoryReadContext({ getRuntimeConfig: () => cfg });
      const respond = await historyRpc(context, "agent:work:main")("chat.history");

      expectHistoryPayload(respond, {
        sessionId: "selected-history-work",
        messages: [expect.objectContaining({ content: "Selected work history" })],
        sessionInfo: expect.objectContaining({
          key: sessionScope === "global" ? "global" : "agent:work:home",
          agentId: "work",
        }),
      });
    });
  },
);

it.each(["chat.history", "chat.startup"] as const)(
  "%s polls an unchanged cursor without hydrating retained subagent tasks",
  async (method) => {
    await withOpenClawTestState(
      { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
      async () => {
        setRuntimeConfigSnapshot({});
        const scope = {
          agentId: "main",
          sessionKey: "agent:main:dashboard:12345678-0aaa-4000-8000-000000000001",
          sessionId: "registry-history",
        };
        await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
        await appendTranscriptMessage(scope, {
          message: { role: "user", content: [{ type: "text", text: "Hello" }] },
        });
        const retained = {
          runId: "retained",
          childSessionKey: "agent:main:subagent:retained",
          requesterSessionKey: scope.sessionKey,
          requesterDisplayKey: "registry-history",
          task: `retained-history-task:${"x".repeat(32_768)}`,
          cleanup: "keep",
          createdAt: 1,
          execution: { status: "terminal", startedAt: 1, endedAt: 2 },
          completion: { required: false },
          delivery: { status: "not_required" },
        } satisfies SubagentRunRecord;
        saveSubagentRegistryToSqlite(new Map([[retained.runId, retained]]));
        const context = await createHistoryReadContext();
        const rpc = historyRpc(context, scope.sessionKey);
        const request = async (cursor?: unknown) => {
          const params =
            method === "chat.startup" && !cursor
              ? { shortId: "12345678", slugHint: "registry-history", agentId: "main" }
              : { sessionKey: scope.sessionKey, ...(cursor ? { cursor } : {}) };
          return historyPayload(await rpc(method, {}, { params }));
        };
        const initial = await request();
        expect(initial.deltaCursor).toEqual(expect.any(String));
        if (method === "chat.startup") {
          expect(initial.resolution).toMatchObject({ ok: true, key: scope.sessionKey });
        }
        clearSubagentRunsReadCacheForTest();
        const parse = vi.spyOn(JSON, "parse");
        try {
          const delta = await request(initial.deltaCursor);
          expect(delta).toMatchObject({ kind: "delta", messages: [] });
          expect(parse.mock.calls.some(([value]) => value.includes("retained-history-task:"))).toBe(
            false,
          );
        } finally {
          parse.mockRestore();
          clearSubagentRunsReadCacheForTest();
        }
      },
    );
  },
);
