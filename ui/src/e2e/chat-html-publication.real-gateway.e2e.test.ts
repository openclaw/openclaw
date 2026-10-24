// Only inference is synthetic; file writes, publication,
// durable history, download authorization, and the browser sandbox are production paths.
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { withTimeout } from "@openclaw/fs-safe/advanced";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { BrowserContext, Frame, Page } from "playwright";
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
import { finishElementAnimations } from "../test-helpers/animations.ts";
import { pairControlUiPage } from "../test-helpers/control-ui-browser-pairing.ts";
import {
  installControlUiE2ePageDiagnosticRing,
  recordControlUiE2eFailureFacts,
} from "../test-helpers/control-ui-e2e-diagnostics.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { clickBoardWidgetControl } from "../test-helpers/control-ui-e2e-widget.ts";
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

async function installCountDiagnostics(context: BrowserContext, page: Page) {
  const key = "__OPENCLAW_HTML_PUBLICATION_DOCUMENT__";
  const prefix = "[html-publication-probe] ";
  const observations: unknown[] = [];
  const record = (value: unknown) => {
    observations.push(value);
    if (observations.length > 64) {
      observations.shift();
    }
  };
  const frameIds = new Map<Frame, number>();
  const frameId = (frame: Frame): number => {
    let id = frameIds.get(frame);
    if (id === undefined) {
      id = frameIds.size;
      frameIds.set(frame, id);
    }
    return id;
  };
  const recordFrameEvent = (event: string, frame: Frame) => {
    const parent = frame.parentFrame();
    record({ event, at: Date.now(), frame: frameId(frame), parent: parent && frameId(parent) });
  };
  page.on("frameattached", (frame) => recordFrameEvent("frameattached", frame));
  page.on("framenavigated", (frame) => recordFrameEvent("framenavigated", frame));
  page.on("framedetached", (frame) => recordFrameEvent("framedetached", frame));
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/mcp-app-sandbox") {
      record({ event: "sandbox-response", csp: response.headers()["content-security-policy"] });
    }
  });
  page.on("pageerror", (error) => {
    record({ event: "pageerror", at: Date.now(), message: error.message, stack: error.stack });
  });
  page.on("console", (message) => {
    const text = message.text();
    if (!text.startsWith(prefix)) {
      return;
    }
    try {
      record(JSON.parse(text.slice(prefix.length)) as unknown);
    } catch {
      record({ event: "unreadable-probe" });
    }
  });
  // Passive observers retain document and event identity even if a frame is replaced.
  // No reads or extra awaits are inserted between readiness and the original click.
  await context.addInitScript(
    ({ key: probeKey, prefix: probePrefix }) => {
      const documentId = `${performance.timeOrigin}:${Math.random()}`;
      Reflect.set(window, probeKey, documentId);
      const emit = (event: string, details: Record<string, unknown> = {}) => {
        const count = document.getElementById("count");
        console.debug(
          probePrefix +
            JSON.stringify({
              event,
              documentId,
              at: performance.timeOrigin + performance.now(),
              readyState: document.readyState,
              value: document.getElementById("value")?.textContent ?? null,
              handler: count?.onclick?.toString() ?? null,
              ...details,
            }),
        );
      };
      for (const event of ["DOMContentLoaded", "load"] as const) {
        window.addEventListener(event, () => emit(event), { once: true });
      }
      window.addEventListener("securitypolicyviolation", (event) =>
        emit("csp-violation", {
          directive: event.effectiveDirective,
          blocked: event.blockedURI,
          line: event.lineNumber,
        }),
      );
      for (const type of ["pointerdown", "pointerup", "click"] as const) {
        for (const capture of [true, false]) {
          window.addEventListener(
            type,
            (event) => {
              const target = event.target instanceof Element ? event.target : null;
              emit(type, {
                capture,
                trusted: event.isTrusted,
                prevented: event.defaultPrevented,
                target: target && { tag: target.tagName, id: target.id },
                x: event.clientX,
                y: event.clientY,
              });
            },
            { capture, passive: true },
          );
        }
      }
    },
    { key, prefix },
  );
  return async () => {
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const expectedScript = /<script>([\s\S]*?)<\/script>/.exec(finalHtml)?.[1];
    const frames = await withTimeout(
      Promise.all(
        page.frames().map(async (frame) => {
          const parent = frame.parentFrame();
          const identity = { frame: frameId(frame), parent: parent && frameId(parent) };
          try {
            const snapshot = await frame.evaluate((probeKey) => {
              const count = document.getElementById("count");
              const documentId = Reflect.get(window, probeKey);
              return {
                documentId: typeof documentId === "string" ? documentId : null,
                readyState: document.readyState,
                value: document.getElementById("value")?.textContent ?? null,
                handler: count?.onclick?.toString() ?? null,
                html: count ? document.documentElement.outerHTML : null,
                scripts: count
                  ? Array.from(document.scripts, (script) => script.textContent ?? "")
                  : [],
                children: Array.from(document.querySelectorAll("iframe"), (child) => ({
                  sandbox: child.getAttribute("sandbox"),
                  srcdoc: child.getAttribute("srcdoc"),
                })),
              };
            }, key);
            const { html, scripts, children } = snapshot;
            return {
              frame: identity.frame,
              parent: identity.parent,
              documentId: snapshot.documentId,
              readyState: snapshot.readyState,
              value: snapshot.value,
              handler: snapshot.handler,
              htmlSha256: html === null ? null : hash(html),
              scriptSha256: scripts.map(hash),
              expectedScriptPresent:
                expectedScript !== undefined && scripts.includes(expectedScript),
              children: children.map(({ srcdoc, sandbox }) => ({
                sandbox,
                srcdocSha256: srcdoc === null ? null : hash(srcdoc),
              })),
            };
          } catch (error) {
            return { frame: identity.frame, parent: identity.parent, error: String(error) };
          }
        }),
      ),
      3_000,
      "HTML publication Count diagnostics",
    );
    const report = JSON.stringify({ expectedHtmlSha256: hash(finalHtml), observations, frames });
    await writeFile(path.join(suite.artifactDir, "count.public.json"), report);
    // The ordinary CI log retains this synthetic-only report even without a media upload.
    console.error("[html-publication-count]", report);
  };
}

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
      async ({ context, page }) => {
        const captureCountDiagnostics = await installCountDiagnostics(context, page);
        const pageEvents = installControlUiE2ePageDiagnosticRing(page);
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
        // Inner-frame readiness does not settle the enclosing panel's layout transition.
        await page
          .locator('[data-region="side"]')
          .filter({ has: panel })
          .evaluate(finishElementAnimations);
        const previewFacts = async (phase: "before" | "after") => {
          const [content, frameBounds] = await Promise.all([
            document.locator("body").evaluate((body) => {
              const button = body.querySelector("button");
              const buttonBounds = button?.getBoundingClientRect();
              const output = body.querySelector("output");
              return {
                timeOrigin: performance.timeOrigin,
                clickHandlerPresent: typeof button?.onclick === "function",
                output: output ? Number(output.textContent) : null,
                buttonX: buttonBounds?.x ?? null,
                buttonY: buttonBounds?.y ?? null,
                buttonWidth: buttonBounds?.width ?? null,
                buttonHeight: buttonBounds?.height ?? null,
              };
            }),
            frame.boundingBox(),
          ]);
          const facts = {
            ...content,
            frameX: frameBounds?.x ?? null,
            frameY: frameBounds?.y ?? null,
            frameWidth: frameBounds?.width ?? null,
            frameHeight: frameBounds?.height ?? null,
          };
          return Object.fromEntries(
            Object.entries(facts).map(([key, value]) => [`htmlPreview_${phase}_${key}`, value]),
          );
        };
        // Retain document identity across the real click; never replay it for diagnostics.
        const beforeClick = withTimeout(previewFacts("before"), 1_000).catch(() => ({}));
        try {
          await clickBoardWidgetControl(
            page,
            document.getByRole("button", { name: "Count", exact: true }),
          );
          await expect.poll(() => document.locator("output").textContent()).toBe("1");
        } catch (error) {
          recordControlUiE2eFailureFacts(page, {
            ...(await beforeClick),
            htmlPreview_pageErrors: pageEvents.filter((event) => event.source === "pageerror")
              .length,
            htmlPreview_consoleErrors: pageEvents.filter(
              (event) => event.source === "console" && event.details.type === "error",
            ).length,
          });
          await withTimeout(previewFacts("after"), 1_000)
            .then((facts) => recordControlUiE2eFailureFacts(page, facts))
            .catch(() => undefined);
          await captureCountDiagnostics().catch((diagnosticError: unknown) => {
            console.error("[html-publication-count] capture failed", String(diagnosticError));
          });
          throw error;
        }
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
