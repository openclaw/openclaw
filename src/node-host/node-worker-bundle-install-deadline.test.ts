import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { NODE_WORKER_BUNDLE_INSTALL_COMMAND } from "../infra/node-commands.js";
import { createDeferredCore } from "../shared/deferred.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import type { NodeHostClient } from "./client.js";
import { handleInvoke } from "./invoke.js";
import { NodeWorkerBundleInstaller } from "./node-worker-bundle-installer.js";
import { buildBundleFixture } from "./node-worker-bundle-installer.test-support.js";

const temps = useAutoCleanupTempDirTracker(afterEach);

it("expires a stalled install through the native invoke budget, joins cleanup, and reuses its queue", async () => {
  const root = await fs.realpath(temps.make("node-install-deadline-"));
  const fixture = await buildBundleFixture(root);
  const entered = createDeferredCore();
  let stalled = true;
  const server = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      http.createServer((_request, response) => {
        if (stalled) {
          entered.resolve();
          return;
        }
        response.writeHead(200, { "content-length": fixture.archive.length });
        response.end(fixture.archive);
      }),
  });
  const expired = new AbortController();
  const timer = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(expired.signal);
  const installer = new NodeWorkerBundleInstaller({ root: path.join(root, "node-host") });
  const request = vi
    .fn<(...args: Parameters<NodeHostClient["request"]>) => Promise<never>>()
    .mockRejectedValue(new Error("Synthetic result acknowledgment unavailable"));
  const invoke = (id: string) =>
    handleInvoke(
      {
        id,
        nodeId: "node-install",
        command: NODE_WORKER_BUNDLE_INSTALL_COMMAND,
        paramsJSON: JSON.stringify(fixture.input),
        timeoutMs: 60_000,
      },
      { request },
      { current: async () => [] },
      undefined,
      {
        workerBundleInstaller: installer,
        gatewayUrl: `ws://127.0.0.1:${server.claim.port}`,
      },
    );
  const running = invoke("stalled");
  try {
    await entered.promise;
    expired.abort(new DOMException("Install deadline expired", "TimeoutError"));
    await running;
    expect(request).toHaveBeenCalledWith(
      "node.invoke.result",
      expect.objectContaining({
        id: "stalled",
        ok: false,
        error: expect.objectContaining({ code: "WORKER_BUNDLE_INSTALL_FAILED" }),
      }),
    );
    expect(
      await fs.readdir(path.join(root, "node-host", fixture.input.gatewayNamespace, "bundles")),
    ).toEqual([]);
    timer.mockRestore();
    stalled = false;
    await invoke("replacement");
    await expect(
      installer.inspect({
        gatewayNamespace: fixture.input.gatewayNamespace,
        bundleHash: fixture.input.build.bundleHash,
      }),
    ).resolves.toMatchObject({ status: "installed" });
    expect(request).toHaveBeenLastCalledWith(
      "node.invoke.result",
      expect.objectContaining({
        id: "replacement",
        ok: true,
      }),
    );
  } finally {
    expired.abort();
    server.listener.closeAllConnections();
    await running;
    timer.mockRestore();
    await server.releaseListener();
    await server.claim.release();
  }
});
