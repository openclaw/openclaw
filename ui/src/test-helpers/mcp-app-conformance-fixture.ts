// Real official App and stdio MCP fixtures shared by conformance scenarios.
import { channel } from "node:diagnostics_channel";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import type { ConsoleMessage, Frame, Locator, Page } from "playwright";
import { expect } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGateway } from "../app/gateway.ts";

const require = createRequire(import.meta.url);
const httpRequests = channel("http.server.request.start");

export function observeMcpAppHttpResponses(gatewayPort: number) {
  const responses: ServerResponse[] = [];
  const onRequest = (message: unknown) => {
    // SAFETY: Node publishes these exact objects before the real HTTP request handler runs.
    const { request, response } = message as {
      request: IncomingMessage;
      response: ServerResponse;
    };
    if (
      request.socket.localPort === gatewayPort &&
      request.method === "POST" &&
      request.url === "/__openclaw__/mcp-app/view"
    ) {
      responses.push(response);
    }
  };
  httpRequests.subscribe(onRequest);
  return { responses, stop: () => httpRequests.unsubscribe(onRequest) };
}

export function observeMcpAppRequests(page: Page) {
  const requests: Array<{ method: string; pathname: string }> = [];
  page.on("request", (request) => {
    if (request.url().includes("mcp-app")) {
      requests.push({ method: request.method(), pathname: new URL(request.url()).pathname });
    }
  });
  return requests;
}

export type McpAppFixtureEvent = {
  event: string;
  scenario: string;
  atMs: number;
  monotonicMs: number;
  method?: string;
  id?: string | number;
  requestId?: string | number;
  tool?: string;
  invocation?: number;
  aborted?: boolean;
};

async function readMcpAppFixtureEvents(
  eventsPath: string,
  scenario?: string,
): Promise<McpAppFixtureEvent[]> {
  const events = (await fs.readFile(eventsPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as McpAppFixtureEvent);
  return scenario === undefined ? events : events.filter((event) => event.scenario === scenario);
}

export function createMcpAppFixtureControl(controlPath: string, eventsPath: string) {
  return {
    readEvents: (scenario?: string) => readMcpAppFixtureEvents(eventsPath, scenario),
    async configure(value: Record<string, unknown>): Promise<void> {
      const nextPath = controlPath + ".next";
      await fs.writeFile(nextPath, JSON.stringify(value));
      await fs.rename(nextPath, controlPath);
    },
  };
}

export function createMcpAppTeardownRecorder(proofDir: string, fixtureEventsPath: string) {
  const records: Array<{
    scenario: string;
    startedAtMs: number;
    observedAtMs: number;
    diagnostics: Array<{ event: string; atMs: number }>;
    events: McpAppFixtureEvent[];
  }> = [];
  return {
    records,
    async run(scenario: string, page: Page, app: Frame, teardown: () => Promise<void>) {
      const startedAtMs = Date.now();
      const diagnostics: Array<{ event: string; atMs: number }> = [];
      const onConsole = (message: ConsoleMessage) => {
        const event = message.text();
        if (
          event === "mcp-conformance-teardown-received" ||
          event === "mcp-conformance-teardown-saved"
        ) {
          diagnostics.push({ event, atMs: Date.now() });
        }
      };
      // Sandbox startup can detach other frames. Only this initialized App's
      // removal during the requested teardown establishes save-before-unmount.
      const onDetached = (frame: Frame) => {
        if (frame === app) {
          diagnostics.push({ event: "app-frame-detached", atMs: Date.now() });
        }
      };
      page.on("console", onConsole);
      page.on("framedetached", onDetached);
      try {
        await teardown();
        await expect.poll(() => page.frames().length).toBe(1);
      } finally {
        page.off("console", onConsole);
        page.off("framedetached", onDetached);
        records.push({
          scenario,
          startedAtMs,
          observedAtMs: Date.now(),
          diagnostics,
          events: await readMcpAppFixtureEvents(fixtureEventsPath, scenario),
        });
        await fs.writeFile(
          path.join(proofDir, "graceful-teardown.json"),
          JSON.stringify(records, null, 2),
        );
      }
      expect(diagnostics.map(({ event }) => event)).toEqual([
        "mcp-conformance-teardown-received",
        "mcp-conformance-teardown-saved",
        "app-frame-detached",
      ]);
    },
  };
}

export async function requestStandaloneUrl(
  page: Page,
  { sessionKey, viewId }: { sessionKey: string; viewId: string },
): Promise<string> {
  return await page.evaluate(
    async (params) => {
      const client = Reflect.get(window, "mcpConformanceClient") as {
        request(method: string, params: unknown): Promise<unknown>;
      };
      const payload = (await client.request("mcp.app.view", {
        sessionKey: params.sessionKey,
        viewId: params.viewId,
      })) as {
        standaloneUrl: string;
      };
      return payload.standaloneUrl;
    },
    { sessionKey, viewId },
  );
}

export async function mountControlUiHost(
  page: Page,
  {
    baseUrl,
    gatewayPort,
    authValue,
    sessionKey,
    viewId,
  }: {
    baseUrl: string;
    gatewayPort: number;
    authValue: string;
    sessionKey: string;
    viewId: string;
  },
): Promise<void> {
  await page.route(`${baseUrl}mcp-conformance`, async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main id="mount"></main>
<script type="module">
import { createApplicationGateway } from "/src/app/gateway-store.ts";
import { waitForGatewayClient } from "/src/app/gateway-readiness.ts";
import { loadSettings } from "/src/app/settings.ts";
import "/src/components/mcp-app-view.tsx";
import { applicationContext } from "/src/app/context.ts";
window.mcpConformanceApplicationContext = applicationContext;
import { MCP_APP_MESSAGE_EVENT } from "/src/components/mcp-app-security.ts";
import { mcpAppMessageText } from "/src/lib/mcp-app-message-content.ts";
window.mcpConformanceConnect = async ({ gatewayUrl, authValue, sessionKey }) => {
  const gateway = createApplicationGateway(
    { ...loadSettings(), gatewayUrl, token: authValue, sessionKey },
    "",
    "",
    { persistDefaultConnectionSettings: false, ownsWarmBoot: false },
  );
  gateway.start();
  const client = await waitForGatewayClient(gateway, AbortSignal.timeout(60_000));
  return { gateway, client };
};
document.addEventListener(MCP_APP_MESSAGE_EVENT, (event) => {
  event.preventDefault();
  window.mcpConformancePrompt = mcpAppMessageText(event.detail.content);
  event.detail.respond(true);
});
window.mcpConformanceUnmount = async () => {
  const mount = document.getElementById("mount");
  const view = window.mcpConformanceView;
  if (!mount || !view) return;
  const frame = view.querySelector("iframe");
  await view.teardown();
  if (frame?.isConnected) throw new Error("MCP App frame remained mounted");
  console.info("mcp-conformance-frame-detached");
  mount.replaceChildren();
};
</script>`,
    });
  });
  await page.goto(`${baseUrl}mcp-conformance`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => Reflect.get(window, "mcpConformanceConnect") !== undefined,
    undefined,
    { timeout: 30_000 },
  );
  await page.evaluate(
    async (params) => {
      const connect = Reflect.get(window, "mcpConformanceConnect") as (connection: {
        gatewayUrl: string;
        authValue: string;
        sessionKey: string;
      }) => Promise<{ gateway: ApplicationGateway; client: GatewayBrowserClient }>;
      const { gateway, client } = await connect(params);
      const view = document.createElement("mcp-app-view");
      const root = document.documentElement;
      const themeListeners = new Set<() => void>();
      const setTheme = (theme: "light" | "dark") => {
        root.dataset.themeMode = theme;
        root.style.setProperty("--card", theme === "light" ? "#ffffff" : "#161920");
        root.style.setProperty("--text", theme === "light" ? "#403c35" : "#d4d4d8");
        for (const listener of themeListeners) {
          listener();
        }
      };
      setTheme("dark");
      const context = {
        gateway,
        theme: {
          subscribe(listener: () => void) {
            themeListeners.add(listener);
            return () => themeListeners.delete(listener);
          },
        },
      };
      document.getElementById("mount")?.addEventListener("context-request", (event) => {
        if (
          Reflect.get(event, "context") !== Reflect.get(window, "mcpConformanceApplicationContext")
        ) {
          return;
        }
        event.stopPropagation();
        Reflect.get(event, "callback")(context);
      });
      view.sessionKey = params.sessionKey;
      view.viewId = params.viewId;
      view.title = "Conformance app";
      document.getElementById("mount")?.appendChild(view);
      Object.assign(window, {
        mcpConformanceClient: client,
        mcpConformanceView: view,
        mcpConformanceSetTheme: setTheme,
      });
    },
    {
      gatewayUrl: `ws://127.0.0.1:${gatewayPort}`,
      authValue,
      sessionKey,
      viewId,
    },
  );
}

export async function waitForText(locator: Locator, expected: string): Promise<void> {
  await expect.poll(() => locator.textContent({ timeout: 500 })).toBe(expected);
}

export async function waitForTextContaining(
  locator: Locator,
  expected: string,
  present = true,
): Promise<void> {
  const assertion = expect.poll(() => locator.textContent());
  if (present) {
    await assertion.toContain(expected);
  } else {
    await assertion.not.toContain(expected);
  }
}

export function readMcpAppModule(): Promise<string> {
  return fs.readFile(require.resolve("@modelcontextprotocol/ext-apps/app-with-deps"), "utf8");
}

export function appHtml(appModuleUrl: string): string {
  return `<!doctype html>
<meta charset="utf-8" />
<style>
  :root {
    --color-background-primary: #f6f5f3;
    --color-text-primary: #17171a;
    --app-accent: #ff4f4f;
  }
  #theme-surface {
    background: var(--color-background-primary);
    color: var(--color-text-primary);
    border-left: 4px solid var(--app-accent);
  }
</style>
<div id="theme-surface">Host-themed surface</div>
<button id="arm-refresh">Arm catalog refresh</button>
<output id="arm-result"></output>
<button id="call-app">Call app tool</button>
<button id="list-tools">List app tools</button>
<button id="call-expiring">Call with deadline</button>
<button id="cancel-call">Cancel app call</button>
<button id="call-model">Call model tool</button>
<button id="read-resource">Read resource</button>
<button id="update-context">Update context</button>
<button id="send-message">Send message</button>
<button id="request-teardown">Request teardown</button>
<output id="initialized">pending</output>
<output id="capabilities"></output>
<output id="ping"></output>
<output id="tools"></output>
<output id="input"></output>
<output id="result"></output>
<output id="app-tool"></output>
<output id="model-tool"></output>
<output id="resource"></output>
<output id="context-update"></output>
<output id="message"></output>
<output id="teardown"></output>
<output id="isolation"></output>
<output id="host-theme"></output>
<output id="host-variables"></output>
<output id="computed-theme"></output>
<script type="module">
import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from ${JSON.stringify(appModuleUrl)};
const write = (id, value) => { document.getElementById(id).textContent = value; };
try { void window.top.document; write("isolation", "failed"); } catch { write("isolation", "isolated"); }
const app = new App({ name: "OpenClaw conformance fixture", version: "1.0.0" });
const applyHostContext = () => {
  const context = app.getHostContext();
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
  const surface = getComputedStyle(document.getElementById("theme-surface"));
  write("host-theme", context?.theme ?? "missing");
  write("host-variables", JSON.stringify(context?.styles?.variables ?? {}));
  write("computed-theme", JSON.stringify({
    background: surface.backgroundColor,
    color: surface.color,
    accent: surface.borderLeftColor,
  }));
};
app.onhostcontextchanged = applyHostContext;
app.ontoolinput = ({ arguments: args }) => write("input", JSON.stringify(args ?? {}));
app.ontoolresult = (value) => write("result", JSON.stringify(value.structuredContent ?? value));
app.onteardown = async () => {
  write("teardown", "received");
  console.info("mcp-conformance-teardown-received");
  const saved = await app.callServerTool({ name: "cleanup_save", arguments: {} });
  if (saved.structuredContent?.value !== "saved") throw new Error("Cleanup save was not accepted");
  write("teardown", "saved");
  console.info("mcp-conformance-teardown-saved");
  return {};
};
app.onerror = (error) => console.error("mcp-conformance-app", error);
document.getElementById("arm-refresh").onclick = async () => {
  write("arm-result", "pending");
  try {
    await app.callServerTool({ name: "arm_refresh", arguments: {} });
    write("arm-result", "armed");
  } catch (error) { write("arm-result", "denied:" + error); }
};
let activeCall;
const callAppTool = async (timeout) => {
  activeCall = new AbortController();
  write("app-tool", "pending");
  try {
    const value = await app.callServerTool({ name: "app_companion", arguments: {} }, {
      signal: activeCall.signal, ...(timeout === undefined ? {} : { timeout }),
    });
    write("app-tool", JSON.stringify(value.structuredContent ?? value));
  } catch (error) { write("app-tool", "denied:" + error); }
};
document.getElementById("call-app").onclick = () => callAppTool();
document.getElementById("list-tools").onclick = async () => {
  try { write("tools", JSON.stringify(await app.request({ method: "tools/list", params: {} }))); }
  catch (error) { write("tools", "denied:" + error); }
};
document.getElementById("call-expiring").onclick = () => callAppTool(3000);
document.getElementById("cancel-call").onclick = () => activeCall?.abort(new Error("fixture caller cancelled"));
document.getElementById("call-model").onclick = async () => {
  try { await app.callServerTool({ name: "model_only", arguments: {} }); write("model-tool", "allowed"); }
  catch (error) { write("model-tool", "denied:" + error); }
};
document.getElementById("read-resource").onclick = async () => {
  try {
    const value = await app.readServerResource({ uri: "data://conformance/value" });
    write("resource", JSON.stringify(value));
  } catch (error) { write("resource", "denied:" + error); }
};
document.getElementById("update-context").onclick = async () => {
  try {
    await app.updateModelContext({ content: [{ type: "text", text: "selected item 42" }] });
    write("context-update", "accepted");
  } catch (error) { write("context-update", "denied:" + error); }
};
document.getElementById("send-message").onclick = async () => {
  try {
    const value = await app.sendMessage({
      role: "user",
      content: [{ type: "text", text: "summarize selection" }],
    });
    write("message", value.isError ? "denied" : "accepted");
  } catch (error) { write("message", "denied:" + error); }
};
document.getElementById("request-teardown").onclick = () => app.requestTeardown();
await app.connect();
applyHostContext();
write("capabilities", JSON.stringify(app.getHostCapabilities() ?? {}));
write("ping", JSON.stringify(await app.request({ method: "ping", params: {} })));
write("initialized", "ready");
</script>`;
}

export async function writeFixtureServer(
  serverPath: string,
  html: string,
  resourceOrigin: string,
  fixtureControlPath: string,
  fixtureEventsPath: string,
): Promise<void> {
  const sdkMcpServerPath = require.resolve("@modelcontextprotocol/server");
  const sdkStdioServerPath = require.resolve("@modelcontextprotocol/server/stdio");
  await fs.writeFile(
    serverPath,
    `#!/usr/bin/env node
import { McpServer } from ${JSON.stringify(sdkMcpServerPath)};
import { StdioServerTransport } from ${JSON.stringify(sdkStdioServerPath)};
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
const controlPath = ${JSON.stringify(fixtureControlPath)};
const eventsPath = ${JSON.stringify(fixtureEventsPath)};
const fixtureHtml = ${JSON.stringify(html)};
const control = () => JSON.parse(readFileSync(controlPath, "utf8"));
const record = (event, detail = {}) => appendFileSync(eventsPath, JSON.stringify({ event, atMs: Date.now(), monotonicMs: performance.now(), scenario: detail.scenario ?? control().scenario, ...detail }) + "\\n");
let delayNextList = false;
let invocations = 0;
const requests = new Map();
class ObservedStdioTransport extends StdioServerTransport {
  async start() {
    const onmessage = this.onmessage;
    this.onmessage = (message, extra) => {
      if (message.method && message.id !== undefined) requests.set(message.id, { method: message.method, tool: message.params?.name, scenario: control().scenario });
      const request = requests.get(message.id ?? message.params?.requestId);
      if (message.method) record("incoming", { method: message.method, id: message.id, requestId: message.params?.requestId, tool: message.params?.name, scenario: request?.scenario });
      onmessage?.(message, extra);
    };
    await super.start();
  }
  async send(message, options) {
    const request = requests.get(message.id);
    if (request?.method === "tools/list") {
      record("list-response-ready", { id: message.id, scenario: request.scenario });
      if (delayNextList) { delayNextList = false; await delay(8000); }
      record("list-response-send", { id: message.id, scenario: request.scenario });
    }
    await super.send(message, options);
    if (request) {
      record("response-written", { id: message.id, ...request, isError: Boolean(message.error) });
    }
  }
}
const appUri = "ui://conformance/app";
const server = new McpServer({ name: "mcp-app-conformance", version: "1.0.0" });
const show = server.registerTool("show", { description: "Show the conformance app" }, async () => ({
  content: [{ type: "text", text: "initial-result" }],
  structuredContent: { value: "initial-result" },
}));
show.update({ _meta: { ui: { resourceUri: appUri } } });
const appOnly = server.registerTool("app_companion", { description: "App-only companion" }, async ({ mcpReq }) => {
  const request = requests.get(mcpReq.id);
  const config = control();
  const callDelayMs = config.callDelayMs ?? 0;
  const invocation = ++invocations;
  const detail = { invocation, requestId: mcpReq.id, scenario: request?.scenario };
  const onAbort = () => record("tool-cancellation-observed", detail);
  mcpReq.signal.addEventListener("abort", onAbort, { once: true });
  record("tool-start", detail);
  try {
    // Noncooperative work models an effect cancellation cannot undo.
    if (config.releasePath) {
      while (!existsSync(config.releasePath)) await delay(25);
    } else {
      await delay(callDelayMs, undefined, config.cooperative ? { signal: mcpReq.signal } : undefined);
    }
    record("tool-complete", { ...detail, aborted: mcpReq.signal.aborted });
  } catch (error) {
    if (mcpReq.signal.aborted) record("tool-stopped", detail);
    throw error;
  } finally {
    mcpReq.signal.removeEventListener("abort", onAbort);
  }
  return {
    content: [{ type: "text", text: "companion-called" }],
    structuredContent: { value: "companion-called", invocation },
  };
});
const arm = server.registerTool("arm_refresh", { description: "Arm fixture catalog response delay" }, async ({ mcpReq }) => {
  const scenario = requests.get(mcpReq.id)?.scenario;
  delayNextList = true;
  await server.server.sendToolListChanged();
  record("notification-sent", { scenario, requestId: mcpReq.id });
  return { content: [{ type: "text", text: "armed" }] };
});
arm.update({ _meta: { ui: { visibility: ["app"] } } });
appOnly.update({ _meta: { ui: { visibility: ["app"] } } });
const cleanupSave = server.registerTool("cleanup_save", { description: "Save App state before unmount" }, async ({ mcpReq }) => {
  const scenario = requests.get(mcpReq.id)?.scenario;
  record("cleanup-save", { scenario, requestId: mcpReq.id });
  return { content: [{ type: "text", text: "saved" }], structuredContent: { value: "saved" } };
});
cleanupSave.update({ _meta: { ui: { visibility: ["app"] } } });
const modelOnly = server.registerTool("model_only", { description: "Model-only tool" }, async () => ({
  content: [{ type: "text", text: "model-called" }],
}));
modelOnly.update({ _meta: { ui: { visibility: ["model"] } } });
server.registerResource("conformance_app", appUri, { mimeType: "text/html;profile=mcp-app" }, async (uri) => ({ contents: [{
    uri: uri.href,
    mimeType: "text/html;profile=mcp-app",
    text: fixtureHtml,
    _meta: { ui: { csp: { resourceDomains: [${JSON.stringify(resourceOrigin)}] } } },
  }] }));
server.registerResource("conformance_data", "data://conformance/value", { mimeType: "text/plain" }, async (uri) => ({
  contents: [{ uri: uri.href, mimeType: "text/plain", text: "resource-ok" }],
}));
await server.connect(new ObservedStdioTransport());
`,
    { encoding: "utf8", mode: 0o755 },
  );
}

export async function findAppFrame(page: Page): Promise<Frame> {
  try {
    await expect
      .poll(
        async () => {
          for (const frame of page.frames()) {
            if ((await frame.locator("#initialized").count()) > 0) {
              return 1;
            }
          }
          return 0;
        },
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);
  } catch (error) {
    const component = await page.evaluate(() => {
      const view = document.querySelector("mcp-app-view");
      return {
        exists: Boolean(view),
        error: view?.querySelector(".error")?.textContent ?? null,
        content: view?.textContent ?? null,
      };
    });
    throw new Error(
      `MCP App inner frame not found: ${JSON.stringify({
        component,
        frames: page.frames().map((frame) => {
          const frameUrl = frame.url();
          if (!frameUrl) {
            return "";
          }
          const url = URL.parse(frameUrl);
          if (!url) {
            return "[invalid frame URL]";
          }
          url.username = "";
          url.password = "";
          url.search = "";
          url.hash = "";
          return url.href;
        }),
      })}`,
      { cause: error },
    );
  }
  let frame: Frame | undefined;
  for (const candidate of page.frames()) {
    if ((await candidate.locator("#initialized").count()) > 0) {
      frame = candidate;
      break;
    }
  }
  if (!frame) {
    throw new Error("MCP App inner frame not found");
  }
  await waitForText(frame.locator("#initialized"), "ready");
  return frame;
}
