import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { BoardSnapshot } from "../../packages/gateway-protocol/src/index.js";
import { readRequestText } from "../../test/helpers/gateway-integration-fixtures.js";
import { startOpenAiResponsesModelServer } from "../../test/helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { resetSubagentRegistryForTests } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { readBoardHtml } from "../boards/board-store.test-support.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { boardStore } from "./board-store.js";
import { writeToolCall } from "./gateway-provider-fixture.test-support.js";
import { createSubagentModelConfig } from "./server.subagent-stop-settlement.product.test-support.js";
import { loadSessionEntryAsync } from "./session-entry-load.test-support.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";

const parentPrompt =
  "Publish the status widget, ask a child for its update, yield, then republish status.";
const childTask = "Return the isolated dashboard update marker.";
const childResult = "DASHBOARD_CHILD_READY_7d61";
type Item = { type?: string; name?: string; call_id?: string; output?: unknown };

afterEach(() => resetSubagentRegistryForTests({ persist: false }));

it("persists a parent dashboard update after public spawn, yield, and completion", async ({
  signal,
}) => {
  let scenario: "allowed" | "revoked" | "reset" = "allowed";
  let completed = createDeferred<unknown>();
  let childRelease = createDeferred();
  let entered = createDeferred();
  let release = createDeferred();
  let settled = createDeferred();
  const failures: string[] = [];
  const put = boardStore.putWidget.bind(boardStore);
  const gate = vi.spyOn(boardStore, "putWidget").mockImplementation(async (params, options) => {
    if (params.content.kind !== "html" || !params.content.html.includes("after child")) {
      return put(params, options);
    }
    entered.resolve();
    if (scenario !== "allowed") {
      await release.promise;
    }
    try {
      return await put(params, options);
    } catch (error) {
      failures.push(String(error));
      throw error;
    } finally {
      settled.resolve();
    }
  });
  const trace: string[] = [];
  const model = await startOpenAiResponsesModelServer({
    modelId: "dashboard-completion",
    bindError: "Expected isolated dashboard model address",
    onRequest: async (request, response) => {
      const raw = await readRequestText(request);
      const body = JSON.parse(raw) as { input: Item[] };
      const calls = body.input.filter((item) => item.type === "function_call");
      const reply = (text: string) =>
        writeOpenAiResponsesText(response, {
          text,
          messageId: randomUUID(),
          responseId: randomUUID(),
        });
      if (raw.includes(parentPrompt)) {
        const toolName = "show_widget";
        const widgets = calls.filter((item) => item.name === toolName);
        if (raw.includes(childResult)) {
          if (widgets.length < 2) {
            trace.push(`completion:${toolName}`);
            writeToolCall(response, toolName, {
              title: "Status",
              name: "status",
              pin: true,
              widget_code: "<p>after child</p>",
            });
          } else {
            const last = widgets.at(-1)!;
            const output = body.input.find(
              (item) => item.type === "function_call_output" && item.call_id === last.call_id,
            )?.output;
            completed.resolve(output);
            reply("Dashboard update finished.");
          }
        } else if (!widgets.length) {
          trace.push(`parent:${toolName}`);
          writeToolCall(response, toolName, {
            title: "Status",
            name: "status",
            pin: true,
            widget_code: "<p>before child</p>",
          });
        } else if (!calls.some((item) => item.name === "sessions_spawn")) {
          trace.push("parent:sessions_spawn");
          writeToolCall(response, "sessions_spawn", { task: childTask, context: "isolated" });
        } else if (!calls.some((item) => item.name === "sessions_yield")) {
          trace.push("parent:sessions_yield");
          writeToolCall(response, "sessions_yield", {});
        } else {
          reply("Waiting for the child.");
        }
      } else if (raw.includes(childTask)) {
        await childRelease.promise;
        trace.push("child:complete");
        reply(childResult);
      } else {
        reply("NO_REPLY");
      }
    },
  });
  const state = await createOpenClawTestState({ label: "dashboard-completion" });
  const base = createSubagentModelConfig(state.workspaceDir, {
    baseUrl: `${model.baseUrl}/v1`,
    modelId: "dashboard-completion",
    runtime: true,
  });
  const token = "dashboard-completion-test-token";
  const gateway = await startGatewayWithClient({
    cfg: {
      ...base,
      tools: { profile: "full", toolSearch: false, codeMode: false },
      gateway: { controlUi: { enabled: false } },
    },
    configPath: state.configPath,
    token,
  });
  const browser = await connectGatewayClient({
    url: `ws://127.0.0.1:${gateway.port}`,
    token,
    caps: ["inline-widgets"],
  });

  try {
    await gateway.server.startupSettled;
    for (const next of ["allowed", "revoked", "reset"] as const) {
      scenario = next;
      completed = createDeferred<unknown>();
      childRelease = createDeferred();
      entered = createDeferred();
      release = createDeferred();
      settled = createDeferred();
      const sessionKey = `agent:main:dashboard:completion-${next}-${randomUUID()}`;
      const accepted = await browser.request<{ runId: string }>("chat.send", {
        sessionKey,
        message: parentPrompt,
        idempotencyKey: randomUUID(),
        deliver: false,
      });
      await expect(
        browser.request("agent.wait", { runId: accepted.runId, timeoutMs: 30_000 }),
      ).resolves.toMatchObject({ status: "ok" });
      childRelease.resolve();
      await withinTest(
        awaitGateBeforeSettlement(
          entered.promise,
          completed.promise,
          "Completion publication refused before the board write",
        ),
        signal,
      );
      if (next === "revoked") {
        await expect(browser.request("chat.abort", { sessionKey })).resolves.toMatchObject({
          aborted: true,
        });
      } else if (next === "reset") {
        const previous = (await loadSessionEntryAsync(sessionKey)).entry;
        await withinTest(browser.request("sessions.reset", { key: sessionKey }), signal);
        const replacement = (await loadSessionEntryAsync(sessionKey)).entry;
        expect(replacement?.lifecycleRevision).not.toBe(previous?.lifecycleRevision);
      }
      release.resolve();
      await withinTest(settled.promise, signal);
      const board = await browser.request<BoardSnapshot>("board.get", { sessionKey });
      expect(trace).toEqual([
        "parent:show_widget",
        "parent:sessions_spawn",
        "parent:sessions_yield",
        "child:complete",
        "completion:show_widget",
      ]);
      const document = await readBoardHtml(boardStore, { sessionKey, agentId: "main" }, "status");
      if (next === "allowed") {
        expect(JSON.stringify(await withinTest(completed.promise, signal))).toContain("pinned");
        expect(board.widgets).toMatchObject([{ name: "status", revision: 2 }]);
        expect(document?.html).toContain("after child");
      } else {
        expect(board.widgets).toMatchObject([{ name: "status", revision: 1 }]);
        expect(document?.html).toContain("before child");
        expect(document?.html).not.toContain("after child");
        expect(failures).toHaveLength(next === "revoked" ? 1 : 2);
      }
      console.log(
        JSON.stringify({
          scenario: next,
          trace: [...trace],
          revision: board.widgets[0]!.revision,
          failures: [...failures],
        }),
      );
      trace.length = 0;
    }
  } finally {
    release.resolve();
    childRelease.resolve();
    gate.mockRestore();
    await disconnectGatewayClient(browser);
    await disconnectGatewayClient(gateway.client);
    await gateway.server.close({ reason: "dashboard completion proof complete" });
    await model.close();
    await state.cleanup();
  }
});
