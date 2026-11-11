import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import type {
  GatewayFrame,
  RequestFrame,
  SessionsCreateResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { loadSessionEntry } from "../../../src/config/sessions/session-accessor.js";
import { registerClonedProjectRegistry } from "../../../src/projects/project-registry.test-support.js";
import { ensureGatewayOwnerProfile } from "../../../src/state/user-profiles.js";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../../test/helpers/openai-responses-sse.ts";
import type { OpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { assertServedUi, chatControls, pairFixture } from "./chat-lifecycle.test-support.ts";
import { createChatGatewayInstance } from "./chat-real-gateway.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const git = promisify(execFile);
let instance: OpenClawTestInstance;
let projectRoot: string;
let projectId: string;
const executionOutputs: string[] = [];
const suite = createControlUiE2eSuite({
  name: "Cloned project checkout choice through a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    const provider = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, response) => {
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            request.resume();
            response.writeHead(404).end();
            return;
          }
          let raw = "";
          request.on("data", (chunk) => {
            raw += chunk.toString();
          });
          request.once("end", () => {
            const body: {
              input?: Array<{ type?: string; output?: unknown }>;
              tools?: Array<{ name?: string }>;
            } = JSON.parse(raw);
            const output = body.input?.at(-1);
            const hasExec = body.tools?.some((tool) => tool.name === "exec");
            if (!hasExec || output?.type === "function_call_output") {
              if (hasExec) {
                executionOutputs.push(String(output?.output));
              }
              writeOpenAiResponsesText(response, {
                text: hasExec
                  ? "Checkout proof ready. " + executionOutputs.length
                  : "Checkout review",
                messageId: "checkout-message-" + executionOutputs.length,
                responseId: "checkout-response-" + executionOutputs.length,
              });
              return;
            }
            const item = {
              type: "function_call",
              id: "fc_checkout_" + executionOutputs.length,
              call_id: "call_checkout_" + executionOutputs.length,
              name: "exec",
              arguments: JSON.stringify({
                command:
                  "node -e \"console.log(process.cwd()); console.log(require('node:fs').existsSync('local-only.txt') ? 'local-work-present' : 'isolated-workspace')\"",
              }),
            };
            writeOpenAiResponsesSse(response, [
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { ...item, arguments: "" },
              },
              {
                type: "response.function_call_arguments.delta",
                output_index: 0,
                item_id: item.id,
                delta: item.arguments,
              },
              {
                type: "response.function_call_arguments.done",
                output_index: 0,
                item_id: item.id,
                arguments: item.arguments,
              },
              { type: "response.output_item.done", output_index: 0, item },
              {
                type: "response.completed",
                response: {
                  id: "checkout-tool-response-" + executionOutputs.length,
                  status: "completed",
                  output: [item],
                  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                },
              },
            ]);
          });
        }),
    });
    const cleanup = () =>
      runQaGatewayFixture(
        () => instance?.cleanup(),
        async () => {
          provider.listener.closeAllConnections();
          await provider.releaseListener();
        },
        () => provider.claim.release(),
      );
    try {
      instance = await createChatGatewayInstance({
        name: "clone-checkout-choice",
        provider: "checkout-fixture",
        identity: "Project assistant",
        model: "echo",
        apiKey: "synthetic-unused-key",
        baseUrl: "http://127.0.0.1:" + provider.claim.port + "/v1",
        models: [{ id: "echo", name: "Checkout fixture" }],
        defaults: { sandbox: { mode: "off" } },
        config: {
          update: { checkOnStart: false },
          browser: { enabled: false },
          tools: {
            profile: "full",
            codeMode: false,
            toolSearch: false,
            exec: { host: "gateway", mode: "full" },
          },
        },
      });
      ensureGatewayOwnerProfile("Project reviewer", { env: instance.env });
      projectRoot = instance.state.path("project");
      await mkdir(projectRoot, { recursive: true });
      await writeFile(path.join(projectRoot, "README.md"), "# Checkout proof\n");
      const runGit = (...args: string[]) =>
        git("git", ["-C", projectRoot, ...args], { env: instance.env });
      await runGit("init", "-b", "main");
      await runGit(
        "-c",
        "user.name=Proof",
        "-c",
        "user.email=proof@example.invalid",
        "add",
        "README.md",
      );
      await runGit(
        "-c",
        "user.name=Proof",
        "-c",
        "user.email=proof@example.invalid",
        "commit",
        "-m",
        "initial",
      );
      projectId = (
        await registerClonedProjectRegistry(
          {
            path: projectRoot,
            name: "Checkout proof",
            originUrl: "https://github.com/example/checkout-proof.git",
          },
          { env: instance.env },
        )
      ).id;
      // Current checkout must preserve local work absent from an isolated checkout.
      await writeFile(path.join(projectRoot, "local-only.txt"), "Keep local work.\n");
      await instance.startGateway();
      return { baseUrl: "http://127.0.0.1:" + instance.port + "/", close: cleanup };
    } catch (error) {
      return runQaGatewayFixture(async () => {
        throw error;
      }, cleanup);
    }
  },
});

suite.define(() => {
  it(
    "opens a cloned project's current main checkout and can still request an isolated worktree",
    (test) =>
      suite.runScenario(test, {
        retainedState: () => instance.stateDir,
        run: () =>
          suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
            const pending = new Map<string, RequestFrame>();
            const creates: Array<{ request: RequestFrame; result: SessionsCreateResult }> = [];
            page.on("websocket", (socket) => {
              socket.on("framesent", ({ payload }) => {
                const frame: GatewayFrame = JSON.parse(String(payload));
                if (frame.type === "req" && frame.method === "sessions.create") {
                  pending.set(frame.id, frame);
                }
              });
              socket.on("framereceived", ({ payload }) => {
                const frame: GatewayFrame = JSON.parse(String(payload));
                if (frame.type !== "res") {
                  return;
                }
                const request = pending.get(frame.id);
                if (!request) {
                  return;
                }
                expect(frame.ok, JSON.stringify(frame.error)).toBe(true);
                creates.push({ request, result: frame.payload as SessionsCreateResult });
                pending.delete(frame.id);
              });
            });
            await pairFixture(page, instance);
            for (const worktree of [false, true]) {
              await page.goto(suite.server.baseUrl + "new");
              await waitForControlUiGatewayReady(page);
              await assertServedUi(page, suite.server.baseUrl);
              await page.locator("#new-session-project-trigger").click();
              await page
                .locator(".new-session-page__project-popover")
                .getByRole("button", { name: /^Checkout proof/ })
                .click();
              await page
                .locator(".new-session-page__message")
                .fill("Review this project on its current branch.");
              await page.locator("#new-session-checkout-trigger").click();
              const checkout = page.locator(".new-session-page__checkout-popover");
              const current = checkout.locator('[data-value="checkout"]');
              await expect
                .poll(() =>
                  page.locator("#new-session-checkout-trigger").getAttribute("data-worktree"),
                )
                .toBe(worktree ? "false" : "true");
              if (process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR && !worktree) {
                const frame = await takeControlUiScreenshotFrame(page, checkout, [current], {
                  animations: "disabled",
                  elements: [checkout],
                });
                await writeFile(path.join(suite.artifactDir, "checkout-options.png"), frame.png);
                await writeFile(
                  path.join(suite.artifactDir, "checkout-options-crop.png"),
                  frame.elements[0]!.png,
                );
              }
              await expect.poll(() => current.isEnabled()).toBe(true);
              await checkout
                .locator('[data-value="' + (worktree ? "worktree" : "checkout") + '"]')
                .click();
              if (worktree) {
                await page.locator("#new-session-worktree-base-ref").fill("main");
              }
              await page.keyboard.press("Escape");
              await page.getByRole("button", { name: "Start session", exact: true }).click();
              await chatControls(page)
                .pane.getByText("Checkout proof ready. " + (worktree ? 3 : 1), { exact: true })
                .last()
                .waitFor({ timeout: 60_000 });
              await expect.poll(() => creates.length).toBe(worktree ? 2 : 1);
              const created = creates.at(-1)!;
              expect(created.request.params).toMatchObject({ projectId, worktree });
              const entry = loadSessionEntry({
                agentId: "main",
                sessionKey: created.result.key,
                env: instance.env,
              });
              if (worktree) {
                expect(entry?.worktree?.id).toBeDefined();
                expect(entry?.spawnedCwd).not.toBe(projectRoot);
                expect(executionOutputs.at(-1)).toContain(entry?.spawnedCwd);
                expect(executionOutputs.at(-1)).toContain("isolated-workspace");
              } else {
                expect(entry?.worktree).toBeUndefined();
                expect(entry?.spawnedCwd).toBe(projectRoot);
                expect(entry?.sessionRoot).toBe(projectRoot);
                expect(executionOutputs.at(-1)).toContain(projectRoot);
                expect(executionOutputs.at(-1)).toContain("local-work-present");
                await chatControls(page).composer.fill("Check the current checkout again.");
                await chatControls(page).send.click();
                await chatControls(page)
                  .pane.getByText("Checkout proof ready. 2", { exact: true })
                  .last()
                  .waitFor({ timeout: 60_000 });
                expect(executionOutputs.at(-1)).toContain(projectRoot);
                expect(executionOutputs.at(-1)).toContain("local-work-present");
              }
            }
            expect(await readFile(path.join(projectRoot, "local-only.txt"), "utf8")).toBe(
              "Keep local work.\n",
            );
            expect(
              (await git("git", ["-C", projectRoot, "branch", "--show-current"])).stdout.trim(),
            ).toBe("main");
          }),
      }),
    240_000,
  );
});
