import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { text as readBody } from "node:stream/consumers";
import { expect as browserExpect } from "playwright/test";
import { afterEach, expect, it } from "vitest";
import { readSessionTranscriptRunId } from "../../../src/sessions/transcript-events.ts";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.ts";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../../test/helpers/openai-responses-sse.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { assertServedUi, chatControls, pairFixture } from "./chat-lifecycle.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

type Mode = "default" | "parent" | "yield" | "collector";
type Input = { type?: string; name?: string; call_id?: string; output?: string };
let plan: {
  mode: Mode;
  parentCalls: number;
  childCalls: number;
  runId?: string;
  childKey?: string;
  grandchildKey?: string;
  grandchildRunId?: string;
  grandchildResponse?: ServerResponse;
  failedResponse?: ServerResponse;
  inputs: string[];
};
const failures: string[] = [];
let instance: OpenClawTestInstance;
let sequence = 0;
function tool(
  response: ServerResponse,
  name: string,
  args: Record<string, unknown>,
  preamble?: string,
) {
  const id = String(++sequence);
  const item = {
    type: "function_call",
    id: "fc_" + id,
    call_id: "call_" + id,
    name,
    arguments: JSON.stringify(args),
    status: "completed",
  };
  const message = {
    type: "message",
    id: "m_" + id,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: preamble ?? "", annotations: [] }],
  };
  const index = preamble ? 1 : 0;
  writeOpenAiResponsesSse(response, [
    ...(preamble
      ? [
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...message, content: [] },
          },
          {
            type: "response.output_text.delta",
            output_index: 0,
            item_id: message.id,
            content_index: 0,
            delta: preamble,
          },
          { type: "response.output_item.done", output_index: 0, item: message },
        ]
      : []),
    { type: "response.output_item.added", output_index: index, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.done",
      output_index: index,
      item_id: item.id,
      arguments: item.arguments,
    },
    { type: "response.output_item.done", output_index: index, item },
    {
      type: "response.completed",
      response: {
        id: "r_" + id,
        status: "completed",
        output: preamble ? [message, item] : [item],
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      },
    },
  ]);
}
const reply = (response: ServerResponse, text: string) =>
  writeOpenAiResponsesText(response, {
    text,
    messageId: "final_" + ++sequence,
    responseId: "final_response_" + sequence,
  });
const suite = createControlUiE2eSuite({
  name: "Parent-owned child failure with real durable handoff and native questions",
  startServerBeforeBrowser: true,
  setupTimeoutMs: 240_000,
  async startServer() {
    const handlers = new Set<Promise<void>>();
    const listener = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, response) => {
          const handler = (async () => {
            if (request.method !== "POST" || request.url !== "/v1/responses") {
              response.writeHead(404).end();
              return;
            }
            const body: { model: string; input: Input[] } = JSON.parse(await readBody(request));
            if (!plan) {
              throw new Error("Unplanned inference request");
            }
            if (body.model === "grandchild") {
              plan.grandchildResponse = response;
              return;
            }
            if (body.model === "child") {
              if (++plan.childCalls === 1) {
                tool(
                  response,
                  plan.mode === "default" ? "sessions_spawn" : "session_status",
                  plan.mode === "default"
                    ? {
                        task: "Finish the synthetic pending investigation.",
                        model: "failure-fixture/grandchild",
                        cleanup: "keep",
                        taskName: "pending-grandchild",
                      }
                    : {},
                  "Saved partial investigation: the synthetic input is intact.",
                );
              } else {
                if (plan.mode === "default") {
                  const spawn = body.input.findLast(
                    (item) => item.type === "function_call" && item.name === "sessions_spawn",
                  );
                  const output = body.input.findLast(
                    (item) =>
                      item.type === "function_call_output" && item.call_id === spawn?.call_id,
                  )?.output;
                  const accepted = JSON.parse(output ?? "{}");
                  expect(accepted.status, output).toBe("accepted");
                  plan.grandchildKey = accepted.childSessionKey;
                  plan.grandchildRunId = accepted.runId;
                }
                plan.failedResponse = response;
              }
              return;
            }
            const call = plan.parentCalls++;
            plan.inputs.push(JSON.stringify(body.input));
            if (call === 0) {
              tool(response, "sessions_spawn", {
                task: "Inspect synthetic input and report saved findings.",
                taskName: "synthetic-child-investigation",
                label: "Synthetic child investigation",
                model: "failure-fixture/child",
                cleanup: "keep",
                ...(plan.mode === "collector" ? { collect: true } : {}),
                ...(plan.mode === "parent" ? { completionTarget: "parent" } : {}),
              });
            } else if (call === 1) {
              const spawn = body.input.findLast(
                (item) => item.type === "function_call" && item.name === "sessions_spawn",
              );
              const output = body.input.findLast(
                (item) => item.type === "function_call_output" && item.call_id === spawn?.call_id,
              )?.output;
              const accepted: { status?: string; runId?: string; childSessionKey?: string } =
                JSON.parse(output ?? "{}");
              expect(accepted.status, output).toBe("accepted");
              plan.runId = accepted.runId;
              plan.childKey = accepted.childSessionKey;
              if (plan.mode === "collector") {
                tool(response, "agents_wait", { ids: [plan.runId], awaitResults: true });
              } else if (plan.mode === "yield") {
                tool(response, "sessions_yield", {});
              } else {
                reply(response, "The investigation is delegated; I will review its findings.");
              }
            } else if (call === 2) {
              expect(JSON.stringify(body.input)).toContain("Synthetic child transport failure");
              expect(JSON.stringify(body.input)).toContain("Saved partial investigation");
              tool(response, "ask_user", {
                questions: [
                  {
                    id: "audience",
                    header: "Audience",
                    question: "Who should receive the recovered report?",
                    options: [
                      {
                        label: "Engineering (Recommended)",
                        description: "Best fit for the technical findings.",
                      },
                      { label: "Everyone", description: "A general summary." },
                    ],
                  },
                ],
              });
            } else if (call === 3) {
              expect(JSON.stringify(body.input)).toMatch(
                /Engineering \(Recommended\)|New contributors/,
              );
              reply(response, "RECOVERED_REPORT_" + plan.mode);
            } else {
              throw new Error("Duplicate parent continuation " + call);
            }
          })();
          handlers.add(handler);
          void handler.then(
            () => handlers.delete(handler),
            (error: unknown) => {
              failures.push(String(error));
              response.destroy();
              handlers.delete(handler);
            },
          );
        }),
    });
    const close = () =>
      runQaGatewayFixture(
        () => instance?.cleanup(),
        async () => {
          listener.listener.closeAllConnections();
          await Promise.allSettled(handlers);
        },
        listener.releaseListener,
        listener.claim.release,
      );
    try {
      instance = await createOpenClawTestInstance({
        name: "owned-child-failure",
        entrypoint: ["dist/index.js"],
        env: {
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          VITEST: undefined,
          NODE_OPTIONS: process.env.OPENCLAW_FAILURE_PROOF_PRELOAD
            ? "--max-old-space-size=16384 --require=" + process.env.OPENCLAW_FAILURE_PROOF_PRELOAD
            : undefined,
        },
        config: {
          update: { checkOnStart: false },
          gateway: { controlUi: { enabled: true } },
          cron: { enabled: false },
          plugins: { allow: [] },
          tools: { profile: "full", codeMode: false, toolSearch: false, swarm: { enabled: true } },
          agents: {
            ownership: "explicit",
            defaults: {
              workspace: "${OPENCLAW_WORKSPACE_DIR}",
              model: "failure-fixture/parent",
              modelPolicy: { allow: ["failure-fixture/*"] },
            },
            entries: { main: { identity: { name: "Recovery assistant" } } },
          },
          models: {
            catalogRefresh: { enabled: false },
            providers: {
              "failure-fixture": {
                api: "openai-responses",
                apiKey: "synthetic-failure-key",
                baseUrl: "http://127.0.0.1:" + listener.claim.port + "/v1",
                models: ["parent", "child", "grandchild"].map((id) => ({ id, name: id })),
              },
            },
          },
        },
      });
      instance.env.OPENCLAW_WORKSPACE_DIR = instance.state.path("public-workspace");
      // This is outside the fixture service TMPDIR, so the shared handoff resolver stays private.
      const handoffTmp = instance.state.path("handoff-tmp");
      await mkdir(handoffTmp);
      instance.env.TMPDIR = handoffTmp;
      instance.env.TMP = handoffTmp;
      instance.env.TEMP = handoffTmp;
      await instance.startGateway();
      return { baseUrl: "http://127.0.0.1:" + instance.port + "/", close };
    } catch (error) {
      return runQaGatewayFixture(async (): Promise<never> => {
        throw error;
      }, close);
    }
  },
});
suite.define(() => {
  afterEach(async () => {
    await writeFile(
      path.join(suite.artifactDir, "runtime-proof.json"),
      JSON.stringify({
        mode: plan?.mode,
        parentCalls: plan?.parentCalls,
        childCalls: plan?.childCalls,
        failures,
        inputs: plan?.inputs,
        logs: instance
          ?.logs()
          .replaceAll(instance.gatewayToken, "[redacted]")
          .replaceAll(instance.hookToken, "[redacted]"),
      }),
    );
  });
  it(
    "returns failures through default, private, yielded and collector custody before native parent answers",
    { timeout: 240_000 },
    async () => {
      await suite.withPage(
        { viewport: { width: 1440, height: 1000 }, locale: "en-US", serviceWorkers: "block" },
        async ({ page }) => {
          await pairFixture(page, instance);
          const rpc = <T>(method: string, params: Record<string, unknown>) =>
            evaluateControlUiContext(
              page,
              async (context, request) => {
                const client = context.gateway.snapshot.client;
                if (!client) {
                  throw new Error("Paired browser client missing");
                }
                return client.request<T>(request.method, request.params);
              },
              { method, params },
            );
          for (const mode of ["default", "parent", "yield", "collector"] as const) {
            plan = { mode, parentCalls: 0, childCalls: 0, inputs: [] };
            const key = "agent:main:failure-proof-" + mode;
            await page.goto(suite.server.baseUrl);
            await waitForControlUiGatewayReady(page);
            await rpc("sessions.create", { key, agentId: "main", label: "Recovery " + mode });
            await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
            await waitForControlUiGatewayReady(page);
            await assertServedUi(page, suite.server.baseUrl);
            const { composer, send } = chatControls(page);
            await composer.fill(
              "Delegate an investigation and recover ordinary errors. Ask me which audience the report should address.",
            );
            await send.click();
            await expect
              .poll(() =>
                failures.length ? failures : [plan.parentCalls, Boolean(plan.failedResponse)],
              )
              .toEqual([2, true]);
            if (mode === "default") {
              await expect.poll(() => Boolean(plan.grandchildResponse)).toBe(true);
            }
            plan.failedResponse!.writeHead(400, { "content-type": "application/json" }).end(
              JSON.stringify({
                error: {
                  type: "invalid_request_error",
                  message: "Synthetic child transport failure",
                },
              }),
            );
            const panel = page
              .locator(".chat-question-panel")
              .filter({ hasText: "Who should receive the recovered report?" });
            await expect
              .poll(() => (failures.length ? failures : plan.parentCalls), { timeout: 30_000 })
              .toBe(3);
            await browserExpect(panel).toBeVisible();
            expect(failures).toEqual([]);
            const describe = () =>
              rpc<{ session: GatewaySessionRow }>("sessions.describe", {
                key: plan.childKey,
                agentId: "main",
              });
            await expect.poll(async () => (await describe()).session?.failureHandedOff).toBe(true);
            expect((await describe()).session).toMatchObject({ status: "failed" });
            if (mode === "default") {
              expect(plan.inputs[2]).toContain(plan.grandchildRunId);
              expect(plan.inputs[2]).toContain("Pending delegated runs");
              expect(
                (
                  await rpc<{ session: GatewaySessionRow }>("sessions.describe", {
                    key: plan.grandchildKey,
                    agentId: "main",
                  })
                ).session.hasActiveRun,
              ).toBe(true);
            }
            await browserExpect(page.locator(".sidebar-child-session-toggle--failed")).toHaveCount(
              0,
            );
            await browserExpect(page.locator(".chat-tool-row__subagent-state--failed")).toHaveCount(
              0,
            );
            if (mode === "default" || mode === "parent") {
              await browserExpect(page.locator(".chat-tool-row__subagent-state")).toHaveText(
                "returned to parent",
              );
            }
            await page.screenshot({
              path: path.join(suite.artifactDir, mode + "-question-pending.png"),
              animations: "disabled",
            });
            await page.reload();
            await waitForControlUiGatewayReady(page);
            await browserExpect(panel).toBeVisible();
            await browserExpect(page.locator(".sidebar-child-session-toggle--failed")).toHaveCount(
              0,
            );
            if (mode === "parent" || mode === "collector") {
              await panel
                .getByRole("textbox", { name: "Your own answer for Audience" })
                .fill("New contributors");
            } else {
              await panel.getByRole("radio", { name: /Engineering/ }).click();
            }
            await panel.getByRole("button", { name: "Submit", exact: true }).click();
            await expect.poll(() => plan.parentCalls).toBe(4);
            await expect
              .poll(async () => JSON.stringify(await rpc("sessions.get", { key, limit: 100 })))
              .toContain("RECOVERED_REPORT_" + mode);
            expect(failures).toEqual([]);
            const history = await rpc<{
              messages: Array<{
                role?: string;
                toolName?: string;
                __openclaw?: { runId?: string };
                content?: unknown;
              }>;
            }>("sessions.get", { key, limit: 100 });
            const answered = history.messages.findLast(
              (message) => message.toolName === "ask_user",
            );
            const final = history.messages.findLast(
              (message) =>
                message.role === "assistant" &&
                JSON.stringify(message.content).includes("RECOVERED_REPORT_" + mode),
            );
            expect(readSessionTranscriptRunId(answered)).toBeTruthy();
            expect(readSessionTranscriptRunId(final)).toBe(readSessionTranscriptRunId(answered));
            if (mode === "default") {
              reply(plan.grandchildResponse!, "Late saved finding");
              await expect
                .poll(
                  async () =>
                    (
                      await rpc<{ session: GatewaySessionRow }>("sessions.describe", {
                        key: plan.grandchildKey,
                        agentId: "main",
                      })
                    ).session.status,
                )
                .toBe("done");
              expect((await describe()).session.status).toBe("failed");
              expect(plan.childCalls).toBe(2);
            }
          }
        },
      );
    },
  );
});
