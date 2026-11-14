// Real Gateway + Control UI + ask_user tool with a scripted model. Proves that human
// interaction stops a question's authoritative expiry while untouched questions still expire.
import { writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { text } from "node:stream/consumers";
import type { Locator, Page } from "playwright-core";
import { expect, it } from "vitest";
import { stampConfigWriteMetadata } from "../../../src/config/io.meta.ts";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.ts";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../../test/helpers/openai-responses-sse.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { pairControlUiPage } from "../test-helpers/control-ui-browser-pairing.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const proof = createControlUiE2eArtifactDir("ask-user-engaged-expiry");
// ask_user clamps timeouts to at least 30 seconds; every case waits past this deadline.
const TIMEOUT_SECONDS = 30;
const ids = [
  "pointer-typing",
  "keyboard-focus",
  "paste",
  "skip-after-engage",
  "untouched",
] as const;
type CaseId = (typeof ids)[number];
const toolResults = new Map<CaseId, unknown>();
let instance: OpenClawTestInstance;
let origin: string;
let lease: Awaited<ReturnType<typeof reserveTestPortListener>>;

function askUser(response: ServerResponse, caseId: CaseId) {
  const item = {
    type: "function_call",
    name: "ask_user",
    arguments: JSON.stringify({
      questions: [
        {
          id: "color",
          header: "Color",
          question: `Which color should ${caseId} use?`,
          options: [{ label: "Blue" }, { label: "Green" }],
        },
      ],
      timeoutSeconds: TIMEOUT_SECONDS,
    }),
    id: "fc_" + caseId,
    call_id: "call_" + caseId,
  };
  writeOpenAiResponsesSse(response, [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: item.id,
      delta: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "response_" + caseId,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

const upstream = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname === "/v1/models") {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ data: [{ id: "questions" }] }));
      return;
    }
    if (url.pathname !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    const body = JSON.parse(await text(request)) as { input?: unknown[] };
    const input = body.input ?? [];
    const caseId = ids.find((candidate) => JSON.stringify(input).includes(`case ${candidate}.`));
    if (!caseId) {
      response.writeHead(400).end();
      return;
    }
    const output = input.find(
      (item): item is { type: string; output: string } =>
        typeof item === "object" &&
        item !== null &&
        (item as { type?: unknown }).type === "function_call_output",
    );
    if (!output) {
      askUser(response, caseId);
      return;
    }
    const payloadText = output.output.trim().split("\n").at(-1) ?? "";
    const payload = JSON.parse(payloadText) as {
      status: string;
      answers?: { answers: Record<string, string[]> };
    };
    toolResults.set(caseId, payload);
    writeOpenAiResponsesText(response, {
      text: `Tool result for ${caseId}: ${payload.status} ${payload.answers?.answers.color?.join(",") ?? "none"}`,
      messageId: caseId + "-final",
      responseId: caseId + "-response-final",
    });
  })().catch(() => {
    if (!response.headersSent) {
      response.writeHead(500);
    }
    response.end();
  });
});

const suite = createControlUiE2eSuite({
  name: "ask_user expiry stops after human interaction",
  startServerBeforeBrowser: true,
  async startServer() {
    lease = await reserveTestPortListener({ offsets: [0], createListener: () => upstream });
    origin = "http://127.0.0.1:" + lease.claim.port;
    instance = await createOpenClawTestInstance({
      name: "ask-user-engaged-expiry",
      env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined },
      config: stampConfigWriteMetadata(
        {
          gateway: { controlUi: { enabled: true } },
          update: { checkOnStart: false },
          cron: { enabled: false },
          tools: { profile: "full", codeMode: false, toolSearch: false },
          agents: {
            defaults: {
              model: "question-fixture/questions",
              modelPolicy: { allow: ["question-fixture/*"] },
            },
            entries: { main: {} },
          },
          models: {
            catalogRefresh: { enabled: false },
            providers: {
              "question-fixture": {
                api: "openai-responses",
                apiKey: "synthetic-question-fixture-key",
                baseUrl: origin + "/v1",
                models: [
                  {
                    id: "questions",
                    name: "Scripted question model",
                    reasoning: false,
                    input: ["text"],
                    contextWindow: 131072,
                    maxTokens: 4096,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  },
                ],
              },
            },
          },
          plugins: { allow: [] },
        },
        "2026.11.3",
        {},
      ),
    });
    const close = async () => {
      try {
        await instance.cleanup();
      } finally {
        upstream.closeAllConnections();
        await lease.releaseListener();
        await lease.claim.release();
      }
    };
    try {
      await instance.startGateway();
    } catch (error) {
      await close();
      throw error;
    }
    return { baseUrl: "http://127.0.0.1:" + instance.port + "/", close };
  },
});

async function engage(caseId: CaseId, page: Page, panel: Locator): Promise<void> {
  const textarea = panel.locator("textarea");
  if (caseId === "pointer-typing" || caseId === "skip-after-engage") {
    await textarea.click();
    await page.keyboard.type("Teal");
    // Blur: focus leaves the question without restarting its deadline.
    await page.getByText(`Ask me which color to use for case ${caseId}.`).click();
    expect(await panel.evaluate((element) => element.contains(document.activeElement))).toBe(false);
    return;
  }
  if (caseId === "keyboard-focus") {
    // Start outside the question, then Tab until keyboard focus enters it.
    await page.getByText(`Ask me which color to use for case ${caseId}.`).click();
    const focused = () => panel.evaluate((element) => element.contains(document.activeElement));
    for (let step = 0; step < 200 && !(await focused()); step++) {
      await page.keyboard.press("Tab");
    }
    expect(await focused()).toBe(true);
    return;
  }
  // Programmatic focus alone must not count; the paste keystroke does.
  await page.evaluate(() => navigator.clipboard.writeText("Teal"));
  await textarea.focus();
  await page.keyboard.press("ControlOrMeta+V");
  await expect.poll(() => textarea.inputValue()).toBe("Teal");
}

suite.define(() => {
  it.each(ids)(
    "%s",
    async (caseId) => {
      await suite.withPage(
        { viewport: { width: 1280, height: 900 }, locale: "en-US", serviceWorkers: "block" },
        async ({ page, context }) => {
          await context.grantPermissions(["clipboard-read", "clipboard-write"]);
          await pairControlUiPage(page, async (args) => {
            const result = await instance.cli(args);
            expect(result.code, result.stderr).toBe(0);
            return result.stdout;
          });
          const key = "agent:main:" + caseId;
          const rpc = <T = unknown>(method: string, params: Record<string, unknown>) =>
            evaluateControlUiContext(
              page,
              (app, input) => app.gateway.snapshot.client!.request<T>(input.method, input.params),
              { method, params },
            );
          await rpc("sessions.create", { key, agentId: "main", label: "Question " + caseId });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, key, "chat"));
          await waitForControlUiGatewayReady(page);
          await rpc("chat.send", {
            sessionKey: key,
            message: `Ask me which color to use for case ${caseId}.`,
            idempotencyKey: caseId + "-original",
          });
          const panel = page.locator(".chat-question-panel").filter({ hasText: caseId });
          await panel.waitFor();
          const listed = await rpc<{
            questions: Array<{ id: string; expiresAtMs: number; status: string }>;
          }>("question.list", {});
          const question = listed.questions.find((candidate) => candidate.status === "pending")!;
          const record = () =>
            rpc<{ question: { status: string; expiresAtMs: number; expiryStoppedAtMs?: number } }>(
              "question.get",
              { id: question.id },
            ).then((result) => result.question);
          if (caseId === "untouched") {
            // Rendering, hover and programmatic focus do not stop an untouched deadline.
            await panel.hover();
            await panel.locator("textarea").focus();
          } else {
            await engage(caseId, page, panel);
          }
          const engaged = await record();
          await writeFile(
            path.join(proof, caseId + "-engaged.json"),
            JSON.stringify(engaged, null, 2),
          );
          // Wait past the original deadline plus the ask_user RPC grace window.
          await page.waitForTimeout(Math.max(0, question.expiresAtMs - Date.now()) + 12_000);
          const afterDeadline = await record();
          await writeFile(
            path.join(proof, caseId + "-after-deadline.json"),
            JSON.stringify(afterDeadline, null, 2),
          );
          if (caseId === "untouched") {
            expect(afterDeadline.status).toBe("expired");
            await page
              .getByRole("paragraph")
              .filter({ hasText: `Tool result for ${caseId}: no_answer none` })
              .waitFor();
            await expect(rpc("question.engage", { id: question.id })).rejects.toThrow();
          } else {
            expect(afterDeadline).toMatchObject({ status: "pending" });
            expect(afterDeadline.expiryStoppedAtMs).toBeGreaterThan(0);
            await page.screenshot({
              path: path.join(proof, caseId + "-after-original-deadline.png"),
              animations: "disabled",
            });
            if (caseId === "skip-after-engage") {
              await expect.poll(() => panel.locator("textarea").inputValue()).toBe("Teal");
              await panel.getByRole("button", { name: "Skip", exact: true }).click();
            } else {
              if (caseId === "keyboard-focus") {
                await panel.getByRole("radio", { name: /^Green/ }).click();
              } else {
                await expect.poll(() => panel.locator("textarea").inputValue()).toBe("Teal");
              }
              await panel.getByRole("button", { name: "Submit", exact: true }).click();
            }
            const expected =
              caseId === "skip-after-engage"
                ? "no_answer none"
                : caseId === "keyboard-focus"
                  ? "answered Green"
                  : "answered Teal";
            await page
              .getByRole("paragraph")
              .filter({ hasText: `Tool result for ${caseId}: ${expected}` })
              .waitFor();
            expect((await record()).status).toBe(
              caseId === "skip-after-engage" ? "cancelled" : "answered",
            );
          }
          await writeFile(
            path.join(proof, caseId + ".json"),
            JSON.stringify(
              {
                caseId,
                questionId: question.id,
                originalExpiresAtMs: question.expiresAtMs,
                afterDeadline,
                toolResult: toolResults.get(caseId),
                model: "Scripted local model; real Gateway, ask_user tool and Control UI.",
              },
              null,
              2,
            ),
          );
        },
      );
    },
    120_000,
  );
});
