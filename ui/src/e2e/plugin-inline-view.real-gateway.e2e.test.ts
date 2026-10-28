import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import {
  buildPluginControlUi,
  writePluginBuildManifest,
} from "../../../src/cli/plugins-control-ui-build.js";
import {
  appendTranscriptMessage,
  replaceSessionEntrySync,
} from "../../../src/config/sessions/session-accessor.js";
import { GatewayClient } from "../../../src/gateway/client.js";
import type { ControlUiHost } from "../../../src/plugin-sdk/control-ui.js";
import { createDeferredCore } from "../../../src/shared/deferred.js";
import { ensureGatewayOwnerProfile } from "../../../src/state/user-profiles.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { createRequireRecord } from "../../../test/helpers/record.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { enterControlUiSession } from "../test-helpers/control-ui-session-entry.ts";
import { verifyGatewayServedControlUiBundle } from "./control-ui-auth-proof.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const sessionKey = "agent:main:inline-authority";
const sessionId = "inline-authority-session";
const toolCallId = "saved-incident-call";
const requireRecord = createRequireRecord("record", "expected-object-value");
let instance: OpenClawTestInstance;
const builds = useAutoCleanupTempDirTracker(afterAll);

type MountProbe = {
  host: ControlUiHost;
  signal: AbortSignal;
  hydration: "pending" | "resolved" | "rejected";
  error?: string;
};
declare global {
  interface Window {
    inlineAuthorityProbe: MountProbe;
    retiredInlineAuthorityProbe: MountProbe;
  }
}

// Observe the example's genuine scoped host and hydration promise without substituting
// registration, auth, lifecycle, requests, responses, or the example's renderer.
const browserProbe = `import example from "./control-ui.ts";
export default {
  ...example,
  activate(host) {
    const ui = new Proxy(host.ui, {
      get(target, key) {
        if (key !== "registerInlineView") return Reflect.get(target, key);
        return (view) => target.registerInlineView({
          ...view,
          mount(element, context) {
            const probe = { host: context.host, signal: context.signal, hydration: "pending" };
            window.inlineAuthorityProbe = probe;
            const observedHost = new Proxy(context.host, {
              get(target, key) {
                if (key !== "request") return Reflect.get(target, key);
                return (method, params) => {
                  const response = target.request(method, params);
                  if (method === "incident-tools.get") response.then(
                    () => { probe.hydration = "resolved"; },
                    (error) => { probe.hydration = "rejected"; probe.error = String(error); },
                  );
                  return response;
                };
              },
            });
            return view.mount(element, { ...context, host: observedHost });
          },
        });
      },
    });
    return example.activate({ ...host, ui });
  },
};`;

const suite = createControlUiE2eSuite({
  name: "Restored native inline view authority through a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    const owner = await createOpenClawTestInstance({
      name: "inline-authority",
      env: { OPENCLAW_TEST_MINIMAL_GATEWAY: "0" },
      config: {
        gateway: { controlUi: { enabled: true, experimental: { customPlugins: true } } },
        cron: { enabled: false },
      },
    });
    instance = owner;
    try {
      const rootDir = owner.state.path("incident-tools");
      const exampleRoot = path.resolve("examples/inline-incident");
      const buildParent = path.join(exampleRoot, ".artifacts");
      await fs.mkdir(buildParent, { recursive: true });
      // Build beside the example's installed devDependencies, then deploy only its package/assets.
      const buildRoot = builds.make("inline-authority-", buildParent);
      for (const name of [
        "index.ts",
        "control-ui.ts",
        "control-ui.css",
        "package.json",
        "openclaw.plugin.json",
      ]) {
        await fs.copyFile(path.join(exampleRoot, name), path.join(buildRoot, name));
      }
      await fs.writeFile(path.join(buildRoot, "authority-probe.ts"), browserProbe);
      const controlUi = await buildPluginControlUi({
        rootDir: buildRoot,
        source: "./authority-probe.ts",
      });
      const manifest = requireRecord(
        JSON.parse(await fs.readFile(path.join(buildRoot, "openclaw.plugin.json"), "utf8")),
      );
      await writePluginBuildManifest(buildRoot, { ...manifest, controlUi });
      await fs.cp(buildRoot, rootDir, { recursive: true });
      const config = requireRecord(JSON.parse(await fs.readFile(owner.configPath, "utf8")));
      await owner.state.writeConfig({
        ...config,
        plugins: {
          allow: ["incident-tools"],
          load: { paths: [rootDir] },
          entries: { "incident-tools": { enabled: true } },
        },
      });
      ensureGatewayOwnerProfile("Synthetic incident viewer", { env: owner.env });
      // Seed an already-saved native tool result through the real transcript owner while
      // the disposable Gateway is offline. This proof does not run a model or tool.
      replaceSessionEntrySync(
        { agentId: "main", sessionKey, env: owner.env },
        {
          sessionId,
          updatedAt: Date.now(),
          label: "Incident authority proof",
          visibility: "shared",
        },
      );
      await appendTranscriptMessage(
        { agentId: "main", sessionKey, sessionId, env: owner.env },
        {
          message: {
            role: "toolResult",
            toolName: "show_incident",
            toolCallId,
            timestamp: Date.now(),
            content: [{ type: "text", text: "INC-42: Elevated checkout latency — Investigating." }],
            details: {
              pluginInlineView: {
                pluginId: "incident-tools",
                viewId: "incident-dashboard",
                version: 1,
                payload: { incidentId: "INC-42" },
                summary: "INC-42: Elevated checkout latency — Investigating.",
              },
              pluginInlineViewInvocation: {
                pluginId: "incident-tools",
                toolName: "show_incident",
                toolCallId,
              },
            },
            __openclaw: { runId: "saved-incident-run" },
          },
        },
      );
      await owner.startGateway();
      return { baseUrl: `http://127.0.0.1:${owner.port}/`, close: () => owner.cleanup() };
    } catch (error) {
      await owner.cleanup();
      throw error;
    }
  },
});

suite.define(() => {
  it("enforces current-viewer writes and retires a restored view during real hydration", async () => {
    const trace: Record<string, unknown>[] = [
      { servedControlUi: await verifyGatewayServedControlUiBundle(suite.server.baseUrl) },
    ];
    const connected = createDeferredCore<string[]>();
    const reader = new GatewayClient({
      url: instance.url,
      token: instance.gatewayToken,
      env: instance.env,
      clientName: "gateway-client",
      mode: "backend",
      role: "operator",
      scopes: ["operator.read"],
      deviceIdentity: null,
      sharedStateMode: "read-only",
      onHelloOk: (hello) => connected.resolve(hello.auth?.scopes ?? []),
      onConnectError: connected.reject,
    });
    reader.start();
    try {
      expect(await connected.promise).toEqual(["operator.read"]);
      const readIncident = () =>
        reader.request<{ acknowledged: boolean }>("incident-tools.get", { incidentId: "INC-42" });
      const beforeDenied = await readIncident();
      expect(beforeDenied).toMatchObject({ acknowledged: false });
      const denial = await reader
        .request("incident-tools.acknowledge", { incidentId: "INC-42" })
        .then(
          () => "unexpected success",
          (error: unknown) => String(error),
        );
      expect(denial).toContain("missing scope: operator.write");
      const afterDenied = await readIncident();
      expect(afterDenied).toMatchObject({ acknowledged: false });
      trace.push({
        viewerScopes: ["operator.read"],
        mutation: "rejected",
        reason: denial,
        acknowledgedBefore: beforeDenied.acknowledged,
        acknowledgedAfter: afterDenied.acknowledged,
      });

      const handoff = await instance.cli(["dashboard", "--json"]);
      expect(handoff.code).toBe(0);
      const issued = requireRecord(JSON.parse(handoff.stdout));
      expect(typeof issued.browserUrl).toBe("string");
      const url = new URL(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "chat"));
      url.hash = new URL(String(issued.browserUrl)).hash;
      await suite.withPage(
        { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
        async ({ page }) => {
          const requests: string[] = [];
          const readIds = new Set<string>();
          let holdNextRead = false;
          let releaseReply: (() => void) | undefined;
          const held = createDeferredCore();
          // Forward the real transport unchanged; pause one authentic hydration reply
          // only after the registered backend handler has produced it.
          await page.routeWebSocket(instance.url + "**", (socket) => {
            const server = socket.connectToServer();
            socket.onMessage((message) => {
              const frame = requireRecord(JSON.parse(message.toString()));
              if (frame.type === "req" && typeof frame.method === "string") {
                requests.push(frame.method);
                if (
                  frame.method === "incident-tools.get" &&
                  holdNextRead &&
                  typeof frame.id === "string"
                ) {
                  holdNextRead = false;
                  readIds.add(frame.id);
                }
              }
              server.send(message);
            });
            server.onMessage((message) => {
              const frame = requireRecord(JSON.parse(message.toString()));
              if (typeof frame.id === "string" && readIds.delete(frame.id)) {
                expect(frame.ok).toBe(true);
                releaseReply = () => socket.send(message);
                held.resolve();
              } else {
                socket.send(message);
              }
            });
          });
          await page.goto(url.toString());
          await enterControlUiSession(page);
          await waitForControlUiGatewayReady(page);
          const inline = page.locator('[data-plugin-inline-view="' + toolCallId + '"]');
          await inline.getByRole("heading", { name: "Elevated checkout latency" }).waitFor();
          await page.reload();
          await inline.getByRole("heading", { name: "Elevated checkout latency" }).waitFor();
          const scopes = await evaluateControlUiContext(
            page,
            (context) => context.gateway.snapshot.hello?.auth?.scopes,
          );
          expect(scopes).toContain("operator.write");
          await inline.getByRole("button", { name: "Acknowledge", exact: true }).click();
          await inline.getByRole("button", { name: "Acknowledged", exact: true }).waitFor();
          const acknowledged = await readIncident();
          expect(acknowledged).toMatchObject({ acknowledged: true });
          expect(requests.filter((method) => method === "incident-tools.acknowledge")).toHaveLength(
            1,
          );
          trace.push({
            restoredFromHistory: true,
            viewerScopes: scopes,
            mutation: "acknowledged",
            independentBackendRead: { acknowledged: acknowledged.acknowledged },
          });

          holdNextRead = true;
          await evaluateControlUiContext(page, (context) => context.plugins.refresh());
          await held.promise;
          await page.evaluate(() => {
            window.retiredInlineAuthorityProbe = window.inlineAuthorityProbe;
            if (window.retiredInlineAuthorityProbe.hydration !== "pending") {
              throw new Error("Hydration was not pending");
            }
          });
          // Catalog refresh retires the mounted-view scope while its hydration is pending.
          await evaluateControlUiContext(page, (context) => context.plugins.refresh());
          expect(await page.evaluate(() => window.retiredInlineAuthorityProbe.signal.aborted)).toBe(
            true,
          );
          await expect
            .poll(() => page.evaluate(() => window.inlineAuthorityProbe.hydration))
            .toBe("resolved");
          releaseReply?.();
          await expect
            .poll(() => page.evaluate(() => window.retiredInlineAuthorityProbe.hydration))
            .toBe("rejected");
          const before = requests.filter((method) => method.startsWith("incident-tools."));
          const retired = await page.evaluate(async () => {
            const probe = window.retiredInlineAuthorityProbe;
            const outcomes = [];
            for (const method of ["incident-tools.get", "incident-tools.acknowledge"]) {
              outcomes.push(
                await probe.host.request(method, { incidentId: "INC-43" }).then(
                  () => "unexpected success",
                  (error: unknown) => String(error),
                ),
              );
            }
            return { hydrationError: probe.error, outcomes };
          });
          expect(retired.hydrationError).toMatch(/ended|active|current|disposed/i);
          expect(retired.outcomes).toHaveLength(2);
          for (const outcome of retired.outcomes) {
            expect(outcome).toMatch(/ended|active|current|disposed/i);
          }
          // A live read is a same-socket barrier after the retained-host attempts. It also
          // proves the observer still sees authenticated traffic and INC-43 was not mutated.
          const afterRetirement = await page.evaluate(() =>
            window.inlineAuthorityProbe.host.request<{ acknowledged: boolean }>(
              "incident-tools.get",
              { incidentId: "INC-43" },
            ),
          );
          expect(afterRetirement).toMatchObject({ acknowledged: false });
          const after = requests.filter((method) => method.startsWith("incident-tools."));
          expect(after.slice(before.length)).toEqual(["incident-tools.get"]);
          const modelTurns = requests.filter((method) => method === "chat.send").length;
          expect(modelTurns).toBe(0);
          trace.push({
            retiredDuringHydration: true,
            ...retired,
            newAuthenticatedRequestsAfterRetirement: after.length - before.length - 1,
            liveReadBarrierRequests: 1,
            unmodifiedIncident: {
              incidentId: "INC-43",
              acknowledged: afterRetirement.acknowledged,
            },
            modelTurns,
          });
        },
      );
    } finally {
      await reader.stopAndWait();
      await fs.writeFile(
        path.join(suite.artifactDir, "authority-trace.json"),
        JSON.stringify(trace, null, 2),
      );
    }
  });
});
