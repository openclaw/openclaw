// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "../src/agents/subagents/registry/subagent-control.test-support.js";
import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import { assert, beforeEach, expect, it, vi } from "vitest";
import { loadTelegramDispatchHttpFixture } from "../extensions/telegram/test-api.js";
import { adoptSubagentProgressDraft } from "../src/agents/subagents/registry/subagent-progress-draft.js";
import {
  requesterKey,
  useSubagentProgressCohort,
} from "../src/agents/subagents/registry/subagent-progress-draft.test-support.js";
import { stopSessionResetSubagents } from "../src/auto-reply/reply/session-reset-cleanup.js";
import { getRuntimeConfig } from "../src/config/config.js";
import { setRuntimeConfigSnapshot } from "../src/config/runtime-snapshot.js";
import { abortControlledSubagents } from "../src/gateway/server-methods/chat-abort-descendants.js";
import { emitAgentEvent } from "../src/infra/agent-events.js";

// Root-owned integration: the subagent registry retires the card Telegram retained.
// The Bot API fixture registers first so the registry fixture's state wins for each case.
const { createTelegramDispatchHttpFixture } = await loadTelegramDispatchHttpFixture();
const http = createTelegramDispatchHttpFixture();
const fixture = useSubagentControlFixture();
beforeEach(() => {
  setRuntimeConfigSnapshot({ agents: { defaults: { workspace: fixture.stateDir } } });
});
const yieldCohort = useSubagentProgressCohort(fixture);

const childTool = (name: string) =>
  emitAgentEvent({ runId: "a", stream: "item", data: { kind: "tool", name, status: "running" } });

// Telegram's progress-lifecycle HTTP suite owns queued/retried edits after draft
// retirement. Here the real registry must retire that draft when stop/reset commits.
it.each(["/stop", "reset"] as const)(
  "a committed %s retires the adopted Telegram card and disconnects child activity",
  async (command) => {
    const spawns = await yieldCohort("parent-turn", ["a"]);
    let adopted = false;
    await http.dispatchProgressTurn(
      async (options) => {
        await http.emitToolStart(options, { name: "exec", phase: "start", toolCallId: "spawn" });
        await http.waitForBotApiCall((call) => call.method === "sendMessage");
      },
      {
        mode: "progress",
        toolProgress: true,
        finalReply: setReplyPayloadMetadata(
          { text: "Waiting for delegated work." },
          {
            progressContinuation: {
              adopt: (draft) => (adopted = adoptSubagentProgressDraft(spawns, draft)),
              close: () => undefined,
            },
          },
        ),
      },
    );
    expect(adopted).toBe(true);
    const [retainedId] = [...http.visibleMessages.keys()];
    assert(retainedId !== undefined);
    childTool("probe_first");
    await vi.advanceTimersByTimeAsync(2_000);
    await http.waitForBotApiCall(
      (call) =>
        call.method === "editMessageText" && String(call.fields.text).includes("Probe First"),
    );

    const params = { cfg: getRuntimeConfig(), sessionKey: requesterKey, agentId: "main" };
    if (command === "/stop") {
      expect((await abortControlledSubagents(params))?.status).toBe("ok");
    } else {
      await stopSessionResetSubagents({ ...params, assertCurrent: () => undefined });
    }
    await fixture.settle();
    await expect.poll(() => http.visibleMessages.has(retainedId), { timeout: 5_000 }).toBe(false);
    expect(
      http.calls.filter(
        (call) => call.method === "deleteMessage" && Number(call.fields.message_id) === retainedId,
      ),
    ).toHaveLength(1);
    const callsAfterRetirement = http.calls.length;
    childTool("probe_second");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(http.calls).toHaveLength(callsAfterRetirement);
  },
);
