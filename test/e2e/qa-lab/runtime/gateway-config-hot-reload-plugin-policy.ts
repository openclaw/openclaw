import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { QaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { createCanvasDocument } from "../../../../src/canvas/documents.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { loadOrCreateDeviceIdentity } from "../../../../src/infra/device-identity.js";
import { withEnvAsync } from "../../../../src/test-utils/env.js";
import {
  connectHotReloadClient,
  waitForHotReloadFact,
  type HotReloadConnection,
} from "./gateway-config-hot-reload-fixtures.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  details: { targetId?: string; viewerUrl?: string; ok?: boolean };
};
type BrowserStatus = { pid: number | null; cdpUrl: string; running: boolean; attachOnly: boolean };
const SESSION_KEY = "agent:qa:hot-reload-plugin";

export async function proveHotReloadPluginPolicy({
  gateway,
  unaffectedNode,
  temporaryRoot,
  outputDir,
  fixtureBaseUrl,
  rpc,
  patch,
  http,
  proveGroup,
  verifyContinuity,
}: {
  gateway: QaGatewayChild;
  unaffectedNode: HotReloadConnection | undefined;
  temporaryRoot: string;
  outputDir: string;
  fixtureBaseUrl: string;
  rpc: <T>(method: string, params?: unknown) => Promise<T>;
  patch: (change: unknown, replacePaths?: string[]) => Promise<unknown>;
  http: (route: string, body?: unknown) => Promise<{ status: number; text: string }>;
  proveGroup: (prefix: string, run: () => Promise<void>) => Promise<void>;
  verifyContinuity: (prefix: string, observation: string) => Promise<void>;
}) {
  const initial = (await rpc<{ config: OpenClawConfig }>("config.get")).config;
  const observations: Array<Record<string, unknown>> = [];
  const tool = async (name: string, args: unknown, sessionKey = SESSION_KEY) => {
    const response = await http("/tools/invoke", { tool: name, sessionKey, args });
    assert.equal(response.status, 200, response.text);
    const { result } = JSON.parse(response.text) as { result: ToolResult };
    assert.notEqual(result.isError, true, response.text);
    assert.notEqual(result.details.ok, false, response.text);
    return result;
  };
  const browser = (args: Record<string, unknown>, sessionKey?: string) =>
    tool("browser", { target: "host", profile: "openclaw", ...args }, sessionKey);
  const browserRequest = <T>(route: string, profile = "openclaw") =>
    rpc<T>("browser.request", {
      target: "host",
      method: "GET",
      path: route,
      query: { profile },
      timeoutMs: 30_000,
    });
  try {
    // Plugin generations can replace services. Finish Canvas changes before measuring Chrome continuity.
    await proveGroup("plugins.entries.canvas.config.host.enabled", async () => {
      assert(unaffectedNode, "Canvas continuity proof requires the approved browser-only node");
      const stateDir = gateway.runtimeEnv.OPENCLAW_STATE_DIR;
      assert(
        stateDir && path.isAbsolute(stateDir),
        "Gateway must have an isolated absolute state dir",
      );
      const canvasHtml = "<!doctype html><html><body>Canvas hot-reload document</body></html>";
      const canvasDocument = await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, () =>
        createCanvasDocument({ title: "Canvas hot-reload document", html: canvasHtml }),
      );
      const originalNode = {
        hellos: unaffectedNode.hellos,
        closes: unaffectedNode.closes,
        bootId: unaffectedNode.bootId,
      };
      const verifyUnaffectedNode = () => {
        assert.equal(unaffectedNode.hellos, originalNode.hellos, "Browser-only node reconnected");
        assert.equal(unaffectedNode.closes, originalNode.closes, "Browser-only node was closed");
        assert.equal(unaffectedNode.bootId, originalNode.bootId);
        return {
          unaffectedNodeHellos: unaffectedNode.hellos,
          unaffectedNodeCloses: unaffectedNode.closes,
        };
      };
      let node: HotReloadConnection | undefined;
      const host = initial.plugins?.entries?.canvas?.config?.host;
      const setEnabled = (enabled: boolean) =>
        patch({ plugins: { entries: { canvas: { config: { host: { enabled } } } } } });
      const routeState = async (enabled: boolean) => {
        const response = await waitForHotReloadFact("Canvas route publication", async () => {
          const current = await http(canvasDocument.entryUrl);
          return current.status === (enabled ? 200 : 404) ? current : undefined;
        });
        if (enabled) {
          assert.equal(response.text, canvasHtml, "Canvas must serve the persisted HTML document");
        }
        return response.status;
      };
      try {
        await setEnabled(false);
        await routeState(false);
        const identity = loadOrCreateDeviceIdentity({
          env: { ...process.env, OPENCLAW_STATE_DIR: temporaryRoot },
          identityKey: "canvas-hot-reload-node",
        });
        const connected = await connectHotReloadClient(gateway, {
          identity,
          caps: ["canvas"],
          commands: [],
        });
        node = connected;
        const pending = await rpc<{
          pending: Array<{ requestId: string; nodeId: string }>;
        }>("node.pair.list");
        const request = pending.pending.find((entry) => entry.nodeId === identity.deviceId);
        assert(request, "New Canvas node must request approval for its declared capability");
        await rpc("node.pair.approve", { requestId: request.requestId });
        await waitForHotReloadFact("approved Canvas node", async () => {
          const { nodes } = await rpc<{
            nodes: Array<{ nodeId: string; connected: boolean; caps: string[] }>;
          }>("node.list");
          return nodes.find(
            (entry) =>
              entry.nodeId === identity.deviceId &&
              entry.connected &&
              entry.caps.includes("canvas"),
          );
        });
        const initialCanvasUrl = connected.pluginSurfaceUrls.canvas;
        assert.equal(initialCanvasUrl, undefined);
        observations.push({
          prefix: "plugins.entries.canvas.config.host.enabled",
          enabled: false,
          routeStatus: 404,
          nodeHellos: connected.hellos,
          nodeCloses: connected.closes,
          ...verifyUnaffectedNode(),
          hasCapabilityUrl: false,
        });
        const bootId = connected.bootId;
        let previousUrl: string | undefined;
        for (const enabled of [true, false, true]) {
          const hellos = connected.hellos;
          const closes = connected.closes;
          await setEnabled(enabled);
          await waitForHotReloadFact("Canvas capability reconnect", () =>
            connected.hellos > hellos && Boolean(connected.pluginSurfaceUrls.canvas) === enabled
              ? true
              : undefined,
          );
          assert.equal(connected.closes, closes + 1);
          assert.equal(connected.hellos, hellos + 1);
          assert.equal(connected.bootId, bootId);
          const status = await routeState(enabled);
          const scopedUrl: string | undefined = connected.pluginSurfaceUrls.canvas;
          if (scopedUrl) {
            assert.notEqual(scopedUrl, previousUrl);
            const document: Response = await fetch(`${scopedUrl}${canvasDocument.entryUrl}`, {
              signal: AbortSignal.timeout(30_000),
            });
            assert.equal(document.status, 200);
            assert.equal(await document.text(), canvasHtml);
            if (previousUrl) {
              const retired = await fetch(`${previousUrl}${canvasDocument.entryUrl}`, {
                signal: AbortSignal.timeout(30_000),
              });
              assert.notEqual(
                retired.status,
                200,
                "Re-enabled Canvas accepted the retired capability",
              );
              await retired.arrayBuffer();
            }
            previousUrl = scopedUrl;
          } else {
            assert(previousUrl);
            const revoked = await fetch(`${previousUrl}${canvasDocument.entryUrl}`, {
              signal: AbortSignal.timeout(30_000),
            });
            assert.notEqual(revoked.status, 200, "Disabled Canvas retained a working capability");
            await revoked.arrayBuffer();
          }
          observations.push({
            prefix: "plugins.entries.canvas.config.host.enabled",
            enabled,
            routeStatus: status,
            nodeHellos: connected.hellos,
            nodeCloses: connected.closes,
            ...verifyUnaffectedNode(),
            hasCapabilityUrl: Boolean(scopedUrl),
          });
        }
        await verifyContinuity(
          "plugins.entries.canvas.config.host.enabled",
          "A node admitted while Canvas was disabled reconnected on enable→disable→re-enable, gained→lost→regained working HTML document URLs, and its old capability stopped working; the browser-only node kept its original connection",
        );
      } finally {
        await node?.client.stopAndWait({ timeoutMs: 2_000 });
        await patch({ plugins: { entries: { canvas: { config: { host: host ?? null } } } } }, [
          "plugins.entries.canvas.config.host",
        ]);
      }
    });

    await proveGroup("gateway.publicOrigin", async () => {
      try {
        for (const origin of [
          "https://diff-a.example.invalid",
          "https://diff-b.example.invalid",
          "https://diff-a.example.invalid",
        ]) {
          await patch({ gateway: { publicOrigin: origin } });
          const result = await tool("diffs", {
            before: "Before hot reload\n",
            after: "After hot reload\n",
            path: "hot-reload-proof.txt",
            title: "Synthetic hot reload diff",
            mode: "view",
          });
          assert(result.details.viewerUrl);
          assert.equal(new URL(result.details.viewerUrl).origin, origin);
          const viewer = await http(new URL(result.details.viewerUrl).pathname);
          assert.equal(viewer.status, 200, viewer.text);
          assert(viewer.text.includes("Synthetic hot reload diff"));
          assert(viewer.text.includes("hot-reload-proof.txt"));
          observations.push({
            prefix: "gateway.publicOrigin",
            origin,
            viewerStatus: viewer.status,
          });
        }
        await verifyContinuity(
          "gateway.publicOrigin",
          "Actual Diffs tool invocations emitted public origins A→B→A and the Gateway served each generated viewer artifact",
        );
      } finally {
        await patch({ gateway: { publicOrigin: initial.gateway?.publicOrigin ?? null } });
      }
    });

    await proveGroup("browser.snapshotDefaults", async () => {
      let targetId: string | undefined;
      try {
        const opened = await browser(
          { action: "open", url: `${fixtureBaseUrl}/widget?snapshot-proof=1` },
          `${SESSION_KEY}-snapshot`,
        );
        targetId = opened.details.targetId;
        assert(targetId);
        const status = await browserRequest<BrowserStatus>("/");
        assert(status.pid, "Snapshot proof must use the Gateway-owned Chromium process");
        for (const efficient of [false, true, false]) {
          await patch({ browser: { snapshotDefaults: efficient ? { mode: "efficient" } : null } });
          const snapshot = await browser({ action: "snapshot", targetId });
          const text = snapshot.content.map((item) => item.text ?? "").join("\n");
          assert(text.includes("Hot reload action"));
          assert.equal(text.includes("Synthetic embedded page"), !efficient);
          assert.equal((await browserRequest<BrowserStatus>("/")).pid, status.pid);
          observations.push({
            prefix: "browser.snapshotDefaults",
            mode: efficient ? "efficient" : "full",
            hasParagraph: text.includes("Synthetic embedded page"),
            hasButton: text.includes("Hot reload action"),
            browserPid: status.pid,
          });
        }
        await verifyContinuity(
          "browser.snapshotDefaults",
          "Actual Browser snapshots changed full→efficient→full: the paragraph disappeared and returned, the interactive button stayed visible, and Chromium kept the same PID and tab",
        );
      } finally {
        if (targetId) {
          await browser({ action: "close", targetId }, `${SESSION_KEY}-snapshot`);
        }
        await patch({ browser: { snapshotDefaults: initial.browser?.snapshotDefaults ?? null } }, [
          "browser.snapshotDefaults",
        ]);
      }
    });
  } finally {
    await fs.writeFile(
      path.join(outputDir, "gateway-config-hot-reload-plugin-policy.json"),
      `${JSON.stringify(observations, null, 2)}\n`,
    );
  }
}
