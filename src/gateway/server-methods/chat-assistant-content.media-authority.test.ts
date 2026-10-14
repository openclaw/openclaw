import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import * as mediaFetch from "../../media/fetch.js";
import { getImageMetadata } from "../../media/media-services.js";
import {
  disposeStoreRemoteFixtures,
  withStoreRemoteFixture,
  wrapStoreSaveRemoteMedia,
} from "../../media/store-network.test-support.js";
import * as mediaStore from "../../media/store.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildAssistantReplyContent } from "./chat-assistant-content.js";

const fixtureLifetime = createFixtureLifetime();
afterEach(() => fixtureLifetime.cleanup());

it("interrupts a pending remote reply attachment when its run is aborted", async ({ signal }) =>
  fixtureLifetime.run(async () => {
    await withOpenClawTestState(
      { label: "reply-media-abort", verifyCleanup: fixtureLifetime.verifyCleanup },
      async (state) => {
        const cleanupState = state.cleanup;
        let stateCleanup: Promise<void> | undefined;
        state.cleanup = () =>
          (stateCleanup ??= fixtureLifetime.verifyCleanup(() => cleanupState()));
        const firstWrite = createDeferred();
        const responseClosed = createDeferred();
        const upstream = http.createServer((_request, response) => {
          response.writeHead(200, { "content-type": "image/png" });
          response.write(Buffer.from("89504e470d0a1a0a", "hex"));
          response.on("close", () => {
            responseClosed.resolve();
          });
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
        const saveMediaStream = mediaStore.saveMediaStream;
        const streamObserver = vi
          .spyOn(mediaStore, "saveMediaStream")
          .mockImplementation((stream, ...args) => {
            const observed = (async function* () {
              for await (const chunk of stream) {
                yield chunk;
                // The store awaits writeFile before pulling again; resumption observes a write.
                firstWrite.resolve();
              }
            })();
            return saveMediaStream(observed, ...args);
          });
        const saving = withStoreRemoteFixture({ url }, () =>
          buildAssistantReplyContent({
            sessionKey: "agent:main:reply-media-abort",
            payloads: [{ mediaUrls: [url] }],
            abortSignal: controller.signal,
            assertCurrent: () => controller.signal.throwIfAborted(),
          }),
        );
        const delivery = saving.then(
          () => ({ completed: true }),
          (error: unknown) => ({ error }),
        );
        try {
          await withinTest(
            awaitGateBeforeSettlement(
              firstWrite.promise,
              saving,
              "Reply settled before partial outgoing media was written",
            ),
            signal,
          );
          const directory = state.statePath("media", "outgoing", "originals");
          const entries = await fs.readdir(directory);
          const stats = await Promise.all(
            entries.map((name) => fs.stat(path.join(directory, name))),
          );
          expect(stats.some((stat) => stat.isFile() && stat.size > 0)).toBe(true);
          controller.abort();
          await withinTest(responseClosed.promise, signal);
          expect(await delivery).toMatchObject({ error: { name: "AbortError" } });
        } finally {
          await fixtureLifetime.verifyCleanup(async () => {
            controller.abort();
            upstream.closeAllConnections();
            await new Promise<void>((resolve) => {
              upstream.close(() => resolve());
            });
            await delivery;
            streamObserver.mockRestore();
            spy.mockRestore();
            disposeStoreRemoteFixtures();
          });
        }
      },
    );
  }));

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
