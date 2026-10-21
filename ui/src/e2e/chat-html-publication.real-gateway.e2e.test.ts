// Only inference is synthetic; file writes, publication,
// durable history, download authorization, and the browser sandbox are production paths.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { writeToolCall } from "../../../src/gateway/gateway-provider-fixture.test-support.ts";
import { ensureGatewayOwnerProfile } from "../../../src/state/user-profiles.ts";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.ts";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { pairControlUiPage } from "../test-helpers/control-ui-browser-pairing.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const sessionKey = "agent:main:html-publication-proof";
const prompt = "Revise the child draft and explicitly attach the final HTML report here.";
const caption = "The final implementation plan is attached.";
const filename = "implementation-plan.html";
const finalHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Implementation plan</title></head>
<body><h1>Parent revision</h1><p>Final bytes: café 雪 🦀</p><button id="count">Count</button>
<output id="value">0</output><script>let count=0;document.querySelector('#count').onclick=()=>document.querySelector('#value').textContent=String(++count);</script></body></html>\r\n`;
let instance: OpenClawTestInstance;
let sourcePath: string;

async function startProvider() {
  const failures: string[] = [];
  const calls: string[] = [];
  let step = 0;
  const owned = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        void (async () => {
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            request.resume();
            response.writeHead(404).end();
            return;
          }
          const body = asOptionalRecord(JSON.parse((await buffer(request)).toString("utf8")));
          if (body?.model === "metadata") {
            writeOpenAiResponsesText(response, {
              text: "HTML publication proof",
              messageId: "metadata",
              responseId: "metadata",
            });
            return;
          }
          expect(body?.model).toBe("publisher");
          const input = JSON.stringify(body?.input);
          const tools = body?.tools;
          if (step++ === 0) {
            expect(input).toContain(prompt);
            expect(tools).toContainEqual(expect.objectContaining({ name: "write" }));
            calls.push("write");
            writeToolCall(response, "write", { path: sourcePath, content: finalHtml });
          } else if (step === 2) {
            expect(input).toContain("function_call_output");
            expect(await readFile(sourcePath, "utf8")).toBe(finalHtml);
            expect(tools).toContainEqual(expect.objectContaining({ name: "message" }));
            calls.push("message");
            writeToolCall(response, "message", {
              action: "send",
              message: caption,
              media: sourcePath,
            });
          } else {
            expect(step).toBe(3);
            expect(input).toContain("function_call_output");
            writeOpenAiResponsesText(response, {
              text: "Publication complete.",
              messageId: "complete",
              responseId: "complete",
            });
          }
        })().catch((error: unknown) => {
          failures.push(String(error));
          if (!response.headersSent) {
            response.writeHead(500);
          }
          response.end("Synthetic provider failed");
        });
      }),
  });
  return {
    port: owned.claim.port,
    failures,
    calls,
    close: () =>
      runQaGatewayFixture(async () => {
        owned.listener.closeAllConnections();
        await owned.releaseListener();
      }, owned.claim.release),
  };
}

let provider: Awaited<ReturnType<typeof startProvider>>;
const suite = createControlUiE2eSuite({
  name: "Explicit HTML publication through real Webchat",
  startServerBeforeBrowser: true,
  async startServer() {
    provider = await startProvider();
    const close = () =>
      runQaGatewayFixture(
        async () => {},
        () => instance?.cleanup(),
        () => provider.close(),
      );
    try {
      instance = await createOpenClawTestInstance({
        name: "html-publication-proof",
        entrypoint: ["dist/index.js"],
        env: {
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENCLAW_SKIP_CANVAS_HOST: "0",
          VITEST: undefined,
        },
        config: {
          update: { checkOnStart: false },
          gateway: {
            controlUi: {
              enabled: true,
              embedSandbox: "scripts",
            },
          },
          cron: { enabled: false },
          browser: { enabled: false },
          tools: { profile: "full", codeMode: false, toolSearch: false },
          agents: {
            ownership: "explicit",
            defaults: {
              workspace: "${OPENCLAW_WORKSPACE_DIR}",
              model: "html-fixture/publisher",
              utilityModel: "html-fixture/metadata",
              modelPolicy: { allow: ["html-fixture/*"] },
              models: {
                "html-fixture/publisher": { params: { transport: "sse" } },
                "html-fixture/metadata": { params: { transport: "sse" } },
              },
            },
            entries: { main: { identity: { name: "Report publisher" } } },
          },
          models: {
            catalogRefresh: { enabled: false },
            providers: {
              "html-fixture": {
                api: "openai-responses",
                apiKey: "synthetic-html-fixture-key",
                baseUrl: `http://127.0.0.1:${provider.port}/v1`,
                request: { allowPrivateNetwork: true },
                models: [
                  { id: "publisher", name: "Publisher" },
                  { id: "metadata", name: "Metadata" },
                ],
              },
            },
          },
          plugins: { allow: ["openai"] },
        },
      });
      instance.env.OPENCLAW_WORKSPACE_DIR = instance.state.path("public-workspace");
      await mkdir(instance.env.OPENCLAW_WORKSPACE_DIR, { recursive: true });
      sourcePath = path.join(instance.env.OPENCLAW_WORKSPACE_DIR, filename);
      await writeFile(sourcePath, "<!doctype html><h1>Child draft</h1>");
      ensureGatewayOwnerProfile("Synthetic report operator", { env: instance.env });
      await instance.startGateway();
      return { baseUrl: `http://127.0.0.1:${instance.port}/`, close };
    } catch (error) {
      return runQaGatewayFixture(async () => {
        throw error;
      }, close);
    }
  },
});

async function cli(args: string[]) {
  const result = await instance.cli(args);
  if (result.code !== 0) {
    throw new Error(
      [
        result.stderr || result.stdout,
        `Gateway child: pid=${instance.child?.pid} exit=${instance.child?.exitCode} signal=${instance.child?.signalCode}`,
        await instance.diagnose(),
        instance.logs(),
      ].join("\n"),
    );
  }
  return result.stdout;
}

async function rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
  return JSON.parse(
    await cli(["gateway", "call", method, "--json", "--params", JSON.stringify(params)]),
  );
}

suite.define(() => {
  it("retains final parent-edited HTML after source deletion, reload, sandbox preview and exact download", async () => {
    await rpc("sessions.create", {
      key: sessionKey,
      agentId: "main",
      label: "HTML publication",
      permissionMode: "full",
    });
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        permissions: ["local-network-access"],
        viewport: { width: 1440, height: 1000 },
      },
      async ({ page }) => {
        await pairControlUiPage(page, cli);
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await waitForControlUiGatewayReady(page);
        await page.getByRole("textbox", { name: "Chat composer", exact: true }).fill(prompt);
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await page
          .locator(".chat-group.assistant .chat-bubble")
          .getByText(caption, { exact: true })
          .first()
          .waitFor()
          .catch((error: unknown) => {
            if (provider.failures.length > 0) {
              throw new Error(provider.failures.join("\n"), { cause: error });
            }
            throw error;
          });
        await page
          .getByRole("button", { name: "Stop generating", exact: true })
          .waitFor({ state: "detached" });
        expect(provider.failures).toEqual([]);
        expect(provider.calls).toEqual(["write", "message"]);
        const history = await rpc("chat.history", { sessionKey, agentId: "main" });
        const historyJson = JSON.stringify(history);
        expect(historyJson).toContain("text/html");
        expect(historyJson).toContain("artifactId");
        expect(historyJson).not.toContain('"type":"attachment_error"');
        await rm(sourcePath);
        await page.reload();
        await waitForControlUiGatewayReady(page);
        await page
          .getByRole("button", { name: `Open ${filename} in the side panel`, exact: true })
          .click();
        const panel = page.locator("openclaw-chat-detail-panel:visible");
        const frame = panel.locator(".chat-html-preview__frame");
        const document = frame.contentFrame().frameLocator("iframe");
        await document.getByRole("heading", { name: "Parent revision", exact: true }).waitFor();
        // The preview retires its loader after the inner document's load acknowledgment.
        await panel
          .locator("openclaw-chat-html-preview [role=status]")
          .waitFor({ state: "hidden" });
        await document.getByRole("button", { name: "Count", exact: true }).click();
        await expect.poll(() => document.locator("output").textContent()).toBe("1");
        expect(
          await document.locator("body").evaluate(() => {
            let topDenied = false;
            try {
              void window.top?.document;
            } catch {
              topDenied = true;
            }
            return { topDenied, api: typeof Reflect.get(window, "openclaw") };
          }),
        ).toEqual({ topDenied: true, api: "undefined" });
        await panel.getByRole("button", { name: "Source", exact: true }).click();
        expect(await panel.locator("pre:visible").textContent()).toBe(finalHtml);
        const downloadLink = panel.getByRole("link", { name: `Download ${filename}`, exact: true });
        const [download] = await Promise.all([page.waitForEvent("download"), downloadLink.click()]);
        const saved = await download.path();
        expect(saved).not.toBeNull();
        expect(await readFile(saved!)).toEqual(Buffer.from(finalHtml));
        expect(download.suggestedFilename()).toBe(filename);
        expect(provider.failures).toEqual([]);
      },
    );
  });
});
