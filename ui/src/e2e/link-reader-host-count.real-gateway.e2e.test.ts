import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  appendTranscriptMessage,
  replaceSessionEntrySync,
} from "../../../src/config/sessions/session-accessor.js";
import { GatewayClient } from "../../../src/gateway/client.js";
import { createDeferredCore } from "../../../src/shared/deferred.js";
import { ensureGatewayOwnerProfile } from "../../../src/state/user-profiles.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { createRequireRecord } from "../../../test/helpers/record.js";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { enterControlUiSession } from "../test-helpers/control-ui-session-entry.ts";
import { connectChatGateway } from "./chat-real-gateway.test-support.ts";
import { verifyGatewayServedControlUiBundle } from "./control-ui-auth-proof.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const requireRecord = createRequireRecord("record", "expected-object-value");
const pluginId = "host-count-proof";
const method = pluginId + ".read";
const sessionKey = "agent:main:exact-host-proof";
const sessionId = "exact-host-proof-session";
const initialHosts = Array.from({ length: 17 }, (_, index) => "notes-" + index + ".example.test");
const replacementHosts = [...initialHosts.slice(0, 16), "notes-17.example.test"];
const itemUrl = (host: string) => "https://" + host + "/items/42";
let instance: OpenClawTestInstance;
let pluginRoot: string;

// A real local plugin owns both passive metadata and independent source-URL authorization.
// It returns synthetic documents without making an external network request.
function pluginSource(hosts: string[], generation: string) {
  return [
    "const hosts = " + JSON.stringify(hosts) + ";",
    "export default { id: 'host-count-proof', name: 'Exact hosts', register(api) {",
    "  api.session.controls.registerControlUiDescriptor({",
    "    id: 'notes', label: 'Exact hosts', surface: 'link-reader', requiredScopes: ['operator.read'],",
    "    linkReader: { hosts, pathPattern: '^/items/[0-9]+$', detailMethod: 'host-count-proof.read' }",
    "  });",
    "  api.registerGatewayMethod('host-count-proof.read', ({params, respond}) => {",
    "    const url = URL.parse(typeof params.url === 'string' ? params.url : '');",
    "    if (!url || url.protocol !== 'https:' || url.username || url.password || url.port ||",
    "        !hosts.includes(url.hostname) || !/^\\/items\\/[0-9]+$/.test(url.pathname)) {",
    "      respond(false, undefined, {code:'INVALID_REQUEST', message:'Unsupported proof URL'}); return;",
    "    }",
    "    respond(true, { url:url.href, title:'Exact-host document ' + url.hostname,",
    "      body:'Served by the real authenticated plugin read method. Catalog generation: " +
      generation +
      ".' });",
    "  }, {scope:'operator.read'});",
    "}};",
  ].join("\n");
}

const suite = createControlUiE2eSuite({
  name: "Exact-host lists through an authenticated real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    const owner = await createOpenClawTestInstance({
      name: "exact-host-count",
      env: { OPENCLAW_TEST_MINIMAL_GATEWAY: "0" },
      config: {
        gateway: { controlUi: { enabled: true } },
        cron: { enabled: false },
        plugins: { allow: [pluginId] },
      },
    });
    instance = owner;
    try {
      pluginRoot = owner.state.path("host-count-plugin");
      await fs.mkdir(pluginRoot, { recursive: true });
      await fs.writeFile(
        path.join(pluginRoot, "package.json"),
        JSON.stringify({
          name: pluginId,
          version: "1.0.0",
          type: "module",
          openclaw: { extensions: ["./index.js"] },
        }),
      );
      await fs.writeFile(
        path.join(pluginRoot, "openclaw.plugin.json"),
        JSON.stringify({
          id: pluginId,
          name: "Exact hosts",
          activation: { onStartup: true },
          uiCapabilities: ["link-reader"],
          configSchema: { type: "object", additionalProperties: false, properties: {} },
        }),
      );
      await fs.writeFile(path.join(pluginRoot, "index.js"), pluginSource(initialHosts, "initial"));
      const config = requireRecord(JSON.parse(await fs.readFile(owner.configPath, "utf8")));
      await owner.state.writeConfig({
        ...config,
        plugins: {
          allow: [pluginId],
          load: { paths: [pluginRoot] },
          entries: { [pluginId]: { enabled: true } },
        },
      });
      ensureGatewayOwnerProfile("Synthetic exact-host viewer", { env: owner.env });
      replaceSessionEntrySync(
        { agentId: "main", sessionKey, env: owner.env },
        {
          sessionId,
          updatedAt: Date.now(),
          label: "Exact-host count proof",
          visibility: "shared",
        },
      );
      await appendTranscriptMessage(
        { agentId: "main", sessionKey, sessionId, env: owner.env },
        {
          message: {
            role: "assistant",
            timestamp: Date.now(),
            content: [
              {
                type: "text",
                text: [
                  "The installed reader supports seventeen exact hosts.",
                  "[First host](" + itemUrl(initialHosts[0]!) + ")",
                  "[Seventeenth host](" + itemUrl(initialHosts[16]!) + ")",
                  "[Replacement host](" + itemUrl(replacementHosts[16]!) + ")",
                ].join("\n\n"),
              },
            ],
          },
        },
      );
      await owner.startGateway();
      return { baseUrl: "http://127.0.0.1:" + owner.port + "/", close: () => owner.cleanup() };
    } catch (error) {
      await owner.cleanup();
      throw error;
    }
  },
});

suite.define(() => {
  it("renders host seventeen, preserves server denials, and refreshes the entire list on reload", async () => {
    const controller = new AbortController();
    const admin = await connectChatGateway(instance, controller.signal);
    const trace: Record<string, unknown> = {
      sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    };
    const deniedHello = createDeferredCore<string[]>();
    const denied = new GatewayClient({
      url: instance.url,
      token: instance.gatewayToken,
      env: instance.env,
      clientName: "gateway-client",
      mode: "backend",
      role: "operator",
      scopes: [],
      deviceIdentity: null,
      sharedStateMode: "read-only",
      onHelloOk: (hello) => deniedHello.resolve(hello.auth?.scopes ?? []),
      onConnectError: deniedHello.reject,
    });
    denied.start();
    try {
      trace.servedControlUi = await verifyGatewayServedControlUiBundle(suite.server.baseUrl);
      const capabilities = await admin.request<{
        controlUiLinkReaders: Array<{ linkReader: { hosts: string[] } }>;
      }>("plugins.uiDescriptors", {});
      expect(capabilities.controlUiLinkReaders[0]!.linkReader.hosts).toEqual(initialHosts);
      const noScopes = await deniedHello.promise;
      expect(noScopes).toEqual([]);
      await expect(denied.request(method, { url: itemUrl(initialHosts[16]!) })).rejects.toThrow(
        /missing scope: operator.read/,
      );
      await expect(admin.request(method, { url: itemUrl("wrong.example.test") })).rejects.toThrow(
        "Unsupported proof URL",
      );
      trace.denials = { missingReadScope: true, wrongExactHost: true };
      const handoff = await instance.cli(["dashboard", "--json"]);
      expect(handoff.code).toBe(0);
      const issued = requireRecord(JSON.parse(handoff.stdout));
      expect(typeof issued.browserUrl).toBe("string");
      const url = new URL(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "chat"));
      url.hash = new URL(String(issued.browserUrl)).hash;
      await suite.withPage(
        { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
        async ({ page }) => {
          await page.route("**/*", (route) =>
            new URL(route.request().url()).hostname === "127.0.0.1"
              ? route.continue()
              : route.abort(),
          );
          const methods: string[] = [];
          page.on("websocket", (socket) =>
            socket.on("framesent", ({ payload }) => {
              const frame = requireRecord(JSON.parse(String(payload)));
              if (frame.type === "req" && typeof frame.method === "string") {
                methods.push(frame.method);
              }
            }),
          );
          await page.goto(url.toString());
          await enterControlUiSession(page);
          await waitForControlUiGatewayReady(page);
          const catalogHosts = () =>
            evaluateControlUiContext(
              page,
              (context) =>
                context.gateway.snapshot.pluginCapabilities?.controlUiLinkReaders?.find(
                  (reader) => reader.pluginId === "host-count-proof",
                )?.linkReader.hosts,
            );
          await expect.poll(catalogHosts).toEqual(initialHosts);
          await page.getByRole("link", { name: "First host", exact: true }).click();
          const pane = page.locator("openclaw-link-reader-panel");
          await pane
            .getByRole("heading", { name: "Exact-host document notes-0.example.test", exact: true })
            .waitFor();
          await page.getByRole("link", { name: "Seventeenth host", exact: true }).click();
          await pane
            .getByRole("heading", {
              name: "Exact-host document notes-16.example.test",
              exact: true,
            })
            .waitFor();
          await pane
            .getByRole("region", { name: "Description", exact: true })
            .getByText(
              "Served by the real authenticated plugin read method. Catalog generation: initial.",
              { exact: true },
            )
            .waitFor();
          await page.screenshot({
            path: path.join(suite.artifactDir, "host-seventeen.png"),
            animations: "disabled",
          });
          expect(methods.filter((name) => name === method)).toHaveLength(2);
          trace.initial = {
            advertisedHosts: (await catalogHosts())?.length,
            renderedHost: "notes-16.example.test",
            readRequests: methods.filter((name) => name === method).length,
          };
          // Reload the plugin through its real lifecycle; no injected capability snapshots or responses.
          await fs.writeFile(
            path.join(pluginRoot, "index.js"),
            pluginSource(replacementHosts, "replacement"),
          );
          const reload = await admin.request<{ restartRequired: boolean }>("plugins.reload", {
            plugins: [{ pluginId }],
          });
          expect(reload.restartRequired).toBe(false);
          await expect.poll(catalogHosts, { timeout: 20_000 }).toEqual(replacementHosts);
          await expect(admin.request(method, { url: itemUrl(initialHosts[16]!) })).rejects.toThrow(
            "Unsupported proof URL",
          );
          await page.getByRole("link", { name: "Replacement host", exact: true }).click();
          await pane
            .getByRole("heading", {
              name: "Exact-host document notes-17.example.test",
              exact: true,
            })
            .waitFor();
          await pane
            .getByRole("region", { name: "Description", exact: true })
            .getByText(
              "Served by the real authenticated plugin read method. Catalog generation: replacement.",
              { exact: true },
            )
            .waitFor();
          await page.screenshot({
            path: path.join(suite.artifactDir, "replacement-host.png"),
            animations: "disabled",
          });
          trace.replacement = {
            advertisedHosts: (await catalogHosts())?.length,
            retiredHostDenied: true,
            renderedHost: "notes-17.example.test",
          };
          trace.modelTurns = methods.filter((name) => name === "chat.send").length;
          expect(trace.modelTurns).toBe(0);
        },
      );
    } finally {
      await denied.stopAndWait();
      await admin.stopAndWait();
      controller.abort();
      await fs.writeFile(
        path.join(suite.artifactDir, "host-count-trace.json"),
        JSON.stringify(trace, null, 2),
      );
    }
  });
});
