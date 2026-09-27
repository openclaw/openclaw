import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as mediaFetch from "../../media/fetch.js";
import { getImageMetadata } from "../../media/media-services.js";
import {
  disposeStoreRemoteFixtures,
  withStoreRemoteFixture,
  wrapStoreSaveRemoteMedia,
} from "../../media/store-network.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildAssistantReplyContent } from "./chat-assistant-content.js";

it("interrupts a pending remote reply attachment when its run is aborted", async () => {
  await withOpenClawTestState({ label: "reply-media-abort" }, async (state) => {
    const started = createDeferred();
    let responseClosed = false;
    const upstream = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "image/png" });
      response.write(Buffer.from("89504e470d0a1a0a", "hex"));
      response.on("close", () => {
        responseClosed = true;
      });
      started.resolve();
    });
    await new Promise<void>((resolve) => {
      upstream.listen(0, "127.0.0.1", resolve);
    });
    const address = upstream.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a listening fixture server");
    }
    const url = `http://127.0.0.1:${address.port}/pending.png`;
    const controller = new AbortController();
    const saveRemoteMedia = mediaFetch.saveRemoteMedia;
    const spy = vi
      .spyOn(mediaFetch, "saveRemoteMedia")
      .mockImplementation(wrapStoreSaveRemoteMedia(saveRemoteMedia));
    const delivery = withStoreRemoteFixture({ url }, () =>
      buildAssistantReplyContent({
        sessionKey: "agent:main:reply-media-abort",
        payloads: [{ mediaUrls: [url] }],
        abortSignal: controller.signal,
        assertCurrent: () => controller.signal.throwIfAborted(),
      }),
    ).then(
      () => ({ completed: true }),
      (error: unknown) => ({ error }),
    );
    try {
      await started.promise;
      await expect
        .poll(async () => {
          const directory = state.statePath("media", "outgoing", "originals");
          if (!existsSync(directory)) {
            return false;
          }
          const entries = await fs.readdir(directory);
          const stats = await Promise.all(
            entries.map((name) => fs.stat(path.join(directory, name))),
          );
          return stats.some((stat) => stat.isFile() && stat.size > 0);
        })
        .toBe(true);
      controller.abort();
      await expect.poll(() => responseClosed).toBe(true);
      expect(await delivery).toMatchObject({ error: { name: "AbortError" } });
    } finally {
      controller.abort();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => {
        upstream.close(() => resolve());
      });
      await delivery;
      spy.mockRestore();
      disposeStoreRemoteFixtures();
    }
  });
});

it("retains the resized image after replacing an owned staging file", async () => {
  await withOpenClawTestState({ label: "reply-media-resize" }, async (state) => {
    const source = state.workspaceDir + "/wide.png";
    const image = createSolidPngBuffer(5000, 32, { r: 80, g: 120, b: 160 });
    await fs.mkdir(state.workspaceDir, { recursive: true });
    await fs.writeFile(source, image);
    const { assistantContent } = await buildAssistantReplyContent({
      sessionKey: "agent:main:reply-media-resize",
      payloads: [{ mediaUrls: [source], trustedLocalMedia: true }],
      managedMediaLocalRoots: [state.workspaceDir],
      assertCurrent: () => {},
    });
    expect(assistantContent?.filter((block) => block.type === "image")).toHaveLength(1);
    const originals = state.statePath("media", "outgoing", "originals");
    const files = await fs.readdir(originals);
    expect(files).toHaveLength(1);
    const dimensions = await getImageMetadata(await fs.readFile(path.join(originals, files[0]!)));
    expect(dimensions?.width).toBeLessThanOrEqual(4096);
    expect(await fs.readFile(source)).toEqual(image);
  });
});
