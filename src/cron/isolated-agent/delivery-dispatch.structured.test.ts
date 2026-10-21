import { expect, it, vi } from "vitest";
import { prepareAgentRunTerminalReply } from "../../agents/agent-run-terminal-reply.js";
import { buildPreparedCliRunContext } from "../../agents/cli-runner.test-helpers.js";
import { buildCliRunResult } from "../../agents/cli-runner/cli-run-settlement.js";
import { prepareCliRunTerminalReply } from "../../agents/cli-runner/terminal-reply.js";
import { createSubagentRunRecord } from "../../agents/subagent-test-fixtures.test-helpers.js";
import { saveSubagentRegistryToSqlite } from "../../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { clearSubagentRunsReadCacheForTest } from "../../agents/subagents/registry/subagent-registry-state.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import {
  installQueueTestPlugin,
  useOutboundRuntime,
} from "../../infra/outbound/deliver.custody.test-support.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { sendCronAnnouncePayloadStrict } from "../delivery.js";
import { dispatchCronDelivery } from "./delivery-dispatch.js";
import { makeBaseParams } from "./delivery-dispatch.test-fixtures.js";
import { readDescendantSubagentFallbackReply } from "./subagent-followup.js";

useOutboundRuntime();

function fixture() {
  installQueueTestPlugin();
  const send = vi.fn(async (_to: string, text: string, _options?: Record<string, unknown>) => ({
    messageId: text,
  }));
  const common = {
    cfg: {},
    deps: { matrix: send },
    agentId: "main",
    jobId: "structured-report",
    target: { channel: "matrix", to: "!room:example" },
    abortSignal: new AbortController().signal,
  };
  return { send, common };
}

function notificationParams(deps: Parameters<typeof dispatchCronDelivery>[0]["deps"]) {
  const params = makeBaseParams({});
  params.cfgWithAgentDefaults = { gateway: { controlUi: { enabled: false } } };
  params.deps = deps;
  params.job = {
    id: "structured-report",
    name: "Structured report",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Report progress", includeReasoning: true },
    delivery: { mode: "announce", channel: "matrix", to: "!room:example" },
    state: {},
  };
  // This synthetic transport has no conversation route; notification custody is still real.
  params.resolvedDelivery = { ok: true, mode: "explicit", channel: "matrix", to: "!room:example" };
  params.synthesizedText = undefined;
  params.summary = params.outputText = "Prepared final";
  return params;
}

it("keeps admitted isolated reasoning in the physical notification", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { common, send } = fixture();
    const params = notificationParams(common.deps);
    params.deliveryPayloads = [
      { text: "Admitted reasoning", isReasoning: true },
      { text: "Prepared final" },
    ];
    const result = await dispatchCronDelivery(params);
    expect(result.deliveryState.status).toBe("delivered");
    expect(send.mock.calls.map(([, text]) => text)).toEqual([
      "Admitted reasoning",
      "Prepared final",
    ]);
  });
});

it("keeps raw notifications on their reasoning and directive normalization path", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { common, send } = fixture();
    const result = await sendCronAnnouncePayloadStrict({
      ...common,
      payload: [
        { text: "Raw reasoning", isReasoning: true },
        { text: "[[reply_to:42]] Raw report" },
      ],
    });
    expect(result.status).toBe("sent");
    expect(send.mock.calls.map(([, text]) => text)).toEqual(["Raw report"]);
  });
});

it.each(["cli", "descendant"] as const)(
  "normalizes reply and media controls from the %s producer before physical delivery",
  async (producer) => {
    await withOpenClawTestState(
      { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
      async () => {
        const { common, send } = fixture();
        const params = notificationParams(common.deps);
        const mediaUrl = "https://example.test/report.png";
        const text = `[[reply_to:42]] Report\nMEDIA:${mediaUrl}`;
        if (producer === "cli") {
          const context = buildPreparedCliRunContext();
          const output = { text };
          const result = buildCliRunResult({
            context,
            output,
            preparedReply: prepareCliRunTerminalReply(context, output),
            usedHistoryPrompt: false,
            userTurnHandled: true,
            sessionBindingDisabled: true,
            preparedContextAgentMeta: {},
          });
          params.deliveryPayloads = result.payloads ?? [];
        } else {
          const child = createSubagentRunRecord({
            runId: "cron-control-child",
            requesterSessionKey: params.runSessionKey,
            requesterDisplayKey: params.runSessionKey,
            childSessionKey: "agent:main:subagent:cron-control-child",
            createdAt: 10,
            execution: { status: "terminal", endedAt: 20, outcome: { status: "ok" } },
            completion: {
              required: false,
              resultText: text,
              terminalReply: prepareAgentRunTerminalReply({ rawText: text }).terminalReply,
            },
            delivery: { status: "not_required" },
          });
          saveSubagentRegistryToSqlite(new Map([[child.runId, child]]));
          clearSubagentRunsReadCacheForTest();
          try {
            const reply = await readDescendantSubagentFallbackReply({
              sessionKey: params.runSessionKey,
              runStartedAt: 10,
            });
            expect(reply).toBeDefined();
            params.deliveryPayloads = [{ text: reply }];
          } finally {
            clearSubagentRunsReadCacheForTest();
          }
        }
        params.summary = params.outputText = undefined;
        const result = await dispatchCronDelivery(params);
        expect(result.deliveryState.status).toBe("delivered");
        expect(
          send.mock.calls.map(([, sentText, options]) => ({
            text: sentText,
            mediaUrl: options?.mediaUrl,
          })),
        ).toEqual([{ text: "Report", mediaUrl }]);
      },
    );
  },
);

it.each(["original", "reset"])(
  "checks the %s session generation before admitted reasoning reaches the transport",
  async (revision) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { common, send } = fixture();
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const sessionKey = "agent:main:structured-report";
      const entry = { sessionId: "structured-report", lifecycleRevision: "original", updatedAt: 1 };
      writeSessionEntry(database, sessionKey, entry);
      const sessionGeneration = {
        agentId: "main",
        storePath: database.path,
        sessionKey,
        sessionId: entry.sessionId,
        lifecycleRevision: entry.lifecycleRevision,
      };
      replaceSessionEntrySync(
        { agentId: "main", storePath: database.path, sessionKey },
        { ...entry, lifecycleRevision: revision, updatedAt: 2 },
      );
      const operation = sendCronAnnouncePayloadStrict({
        ...common,
        payload: { text: "Admitted reasoning", isReasoning: true },
        admittedReasoning: true,
        sessionGeneration,
      });
      if (revision === "original") {
        await expect(operation).resolves.toMatchObject({ status: "sent" });
        expect(send.mock.calls.map(([, text]) => text)).toEqual(["Admitted reasoning"]);
      } else {
        await expect(operation).rejects.toThrow(
          "The original session generation no longer accepts this delivery.",
        );
        expect(send).not.toHaveBeenCalled();
      }
    });
  },
);
