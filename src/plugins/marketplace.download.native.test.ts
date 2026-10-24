import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as guardedFetch from "../infra/net/fetch-guard.js";
import * as tmpRoot from "../infra/tmp-openclaw-dir.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { installPluginFromMarketplace } from "./marketplace.js";
import { writeMarketplaceManifest } from "./marketplace.test-support.js";

const installPluginFromPathMock = vi.hoisted(() => vi.fn());

// mock-isolation: A timed-out download must never enter the stateful plugin installer.
vi.mock("./install.js", () => ({ installPluginFromPath: installPluginFromPathMock }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  installPluginFromPathMock.mockReset();
});

it.for([
  { kind: "stalled", startDrip: () => undefined, minimumChunks: 1 },
  {
    kind: "slow-drip",
    startDrip: (sendChunk: () => void) => setInterval(sendChunk, 100),
    minimumChunks: 2,
  },
])(
  "bounds a $kind archive through the real guarded marketplace download",
  async ({ startDrip, minimumChunks }, { signal }) => {
    const rootDir = tempDirs.make("openclaw-marketplace-native-");
    const downloadDir = path.join(rootDir, "downloads");
    await fs.mkdir(downloadDir);
    vi.spyOn(tmpRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(downloadDir);
    const realGuard = guardedFetch.fetchWithSsrFGuard;
    vi.spyOn(guardedFetch, "fetchWithSsrFGuard").mockImplementation((params) =>
      // Only fixture admission differs: DNS, native HTTP, abort and release remain real.
      realGuard({ ...params, policy: { ...params.policy, allowPrivateNetwork: true } }),
    );

    const closed = createDeferred();
    let chunksSent = 0;
    const fixture = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((_request, response) => {
          response.writeHead(200, { "content-type": "application/octet-stream" });
          const sendChunk = () => {
            response.write("unfinished archive");
            chunksSent += 1;
          };
          sendChunk();
          // Sub-budget progress must not restart the overall network deadline.
          const drip = startDrip(sendChunk);
          response.once("close", () => {
            clearInterval(drip);
            closed.resolve();
          });
        }),
    });

    try {
      const archiveUrl = `http://127.0.0.1:${fixture.claim.port}/plugin.tgz`;
      const marketplace = await writeMarketplaceManifest(rootDir, {
        plugins: [{ name: "fixture-plugin", source: archiveUrl }],
      });
      const result = await withinTest(
        installPluginFromMarketplace({ marketplace, plugin: "fixture-plugin", timeoutMs: 1_000 }),
        signal,
      );

      assert(!result.ok, "an unfinished archive must not install");
      expect(result.error).toContain(`failed to download ${archiveUrl}:`);
      expect(result.error).toMatch(/timed out|aborted/i);
      expect(chunksSent).toBeGreaterThanOrEqual(minimumChunks);
      expect(installPluginFromPathMock).not.toHaveBeenCalled();
      expect(await fs.readdir(downloadDir)).toEqual([]);
      await withinTest(closed.promise, signal);
    } finally {
      fixture.listener.closeAllConnections();
      try {
        await fixture.releaseListener();
      } finally {
        await fixture.claim.release();
      }
    }
  },
);
