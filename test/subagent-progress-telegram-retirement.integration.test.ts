// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "../src/agents/subagents/registry/subagent-control.test-support.js";
import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import { assert, expect, it, vi } from "vitest";
import {
  apiThrottler,
  getOrCreateAccountThrottler,
  loadTelegramDispatchHttpFixture,
  type ReplyResolverOptions,
} from "../extensions/telegram/test-api.js";
import { adoptSubagentProgressDraft } from "../src/agents/subagents/registry/subagent-progress-draft.js";
import {
  requesterKey,
  useSubagentProgressCohort,
} from "../src/agents/subagents/registry/subagent-progress-draft.test-support.js";
import { stopSessionResetSubagents } from "../src/auto-reply/reply/session-reset-cleanup.js";
import { getRuntimeConfig } from "../src/config/config.js";
import { abortControlledSubagents } from "../src/gateway/server-methods/chat-abort-runtime.js";
import { emitAgentEvent } from "../src/infra/agent-events.js";

// Root-owned integration: the subagent registry retires the card Telegram retained.
// The Bot API fixture registers first so the registry fixture's state wins for each case.
const { createTelegramDispatchHttpFixture } = await loadTelegramDispatchHttpFixture();
const http = createTelegramDispatchHttpFixture();
const fixture = useSubagentControlFixture();
const yieldCohort = useSubagentProgressCohort(fixture);

const childTool = (name: string) =>
  emitAgentEvent({ runId: "a", stream: "item", data: { kind: "tool", name, status: "running" } });

// Each command commits through the registry; the Telegram fence is the same for either.
it.each([
  ["/stop", false],
  ["reset", true],
] as const)(
  "a committed %s keeps a retained edit awaiting Telegram admission off the network (retried: %s)",
  async (command, retried) => {
    // The account scheduler is where an edit waits before network admission.
    http.bot.api.config.use(
      getOrCreateAccountThrottler(http.token, () =>
        apiThrottler({ global: {}, group: { maxConcurrent: 1 }, out: { maxConcurrent: 1 } }),
      ).transformer,
    );
    const spawns = await yieldCohort("parent-turn", ["a"]);
    let adopted = false;
    let parentCallbacks: ReplyResolverOptions | undefined;
    await http.dispatchProgressTurn(
      async (options) => {
        parentCallbacks = options;
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
    const isEditWith =
      (title: string) => (call: { method: string; fields: Record<string, unknown> }) =>
        call.method === "editMessageText" && String(call.fields.text).includes(title);
    // Requests entering the account scheduler, before any queue wait.
    const entered: string[] = [];
    http.bot.api.config.use((previous, method, payload, signal) => {
      entered.push(`${method}:${JSON.stringify(payload)}`);
      return previous(method, payload, signal);
    });
    // A queued turn's card holds this chat's request lane, so the retained edit
    // under test waits in the account scheduler, not on the network.
    const held = {
      predicate: (call: { method: string }) => call.method === "sendMessage",
      arrived: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    };
    http.holdNextCall = held;
    const startQueuedTurn = async () => {
      await parentCallbacks?.onQueuedFollowupAdmitted?.();
      return http.emitToolStart(parentCallbacks, {
        name: "web_search",
        phase: "start",
        toolCallId: "queued",
      });
    };
    let queuedTool: Promise<unknown>;
    if (retried) {
      // The second child update arrives while the first edit is in flight, so a
      // scheduled flush retries it after its first attempt fails.
      const first = {
        arrived: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      };
      const second = {
        arrived: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      };
      let secondFailed = false;
      http.respondToCall = async (call) => {
        if (isEditWith("Probe First")(call)) {
          first.arrived.resolve();
          await first.release.promise;
          return undefined;
        }
        if (secondFailed || !isEditWith("Probe Second")(call)) {
          return undefined;
        }
        secondFailed = true;
        second.arrived.resolve();
        await second.release.promise;
        return { error_code: 500, description: "Internal Server Error: fixture" };
      };
      childTool("probe_first");
      await first.arrived.promise;
      childTool("probe_second");
      await vi.advanceTimersByTimeAsync(2_000);
      first.release.resolve();
      await second.arrived.promise;
      queuedTool = startQueuedTurn();
      await expect
        .poll(() => entered.some((entry) => entry.includes("Web Search")), { timeout: 5_000 })
        .toBe(true);
      second.release.resolve();
      await held.arrived.promise;
    } else {
      queuedTool = startQueuedTurn();
      await held.arrived.promise;
      childTool("probe_second");
    }
    await vi.advanceTimersByTimeAsync(2_000);
    expect(
      entered.filter(
        (entry) => entry.startsWith("editMessageText:") && entry.includes("Probe Second"),
      ),
    ).toHaveLength(retried ? 2 : 1);

    const params = { cfg: getRuntimeConfig(), sessionKey: requesterKey, agentId: "main" };
    if (command === "/stop") {
      expect((await abortControlledSubagents(params))?.status).toBe("ok");
    } else {
      await stopSessionResetSubagents({ ...params, assertCurrent: () => undefined });
    }
    await fixture.settle();
    held.release.resolve();
    await queuedTool;
    await expect.poll(() => http.visibleMessages.has(retainedId), { timeout: 5_000 }).toBe(false);
    // Only a failed attempt made before the committed cancellation reached Telegram.
    expect(http.calls.filter(isEditWith("Probe Second"))).toHaveLength(retried ? 1 : 0);
  },
);
