import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import * as httpFixture from "../../../test/helpers/gateway-integration-fixtures.js";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import * as gates from "../../../test/helpers/promise.js";
import * as mediaFetch from "../../media/fetch.js";
import { getImageMetadata } from "../../media/media-services.js";
import * as network from "../../media/store-network.test-support.js";
import * as mediaStore from "../../media/store.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildAssistantReplyContent } from "./chat-assistant-content.js";

const lifetime = createFixtureLifetime();
const { run, verifyCleanup } = lifetime;
afterEach(() => lifetime.cleanup());

it("interrupts a pending remote reply attachment when its run is aborted", async ({ signal }) =>
  run(() =>
    withOpenClawTestState({ label: "reply-media-abort", verifyCleanup }, async (state) => {
      const cleanupState = state.cleanup;
      state.cleanup = () => verifyCleanup(cleanupState);
      const firstWrite = gates.createDeferred();
      const responseClosed = gates.createDeferred();
      const upstream = http.createServer((_request, response) => {
        response.writeHead(200, { "content-type": "image/png" });
        response.write(Buffer.from("89504e470d0a1a0a", "hex"));
        response.on("close", () => responseClosed.resolve());
      });
      const url = `${await httpFixture.listenLoopback(upstream)}/pending.png`;
      const controller = new AbortController();
      const saveRemoteMedia = mediaFetch.saveRemoteMedia;
      using remoteSpy = vi.spyOn(mediaFetch, "saveRemoteMedia");
      remoteSpy.mockImplementation(network.wrapStoreSaveRemoteMedia(saveRemoteMedia));
      const saveMediaStream = mediaStore.saveMediaStream;
      async function* observeWrites(stream: AsyncIterable<unknown>) {
        for await (const chunk of stream) {
          yield chunk; // The store resumes only after writeFile finishes.
          firstWrite.resolve();
        }
      }
      using streamSpy = vi.spyOn(mediaStore, "saveMediaStream");
      streamSpy.mockImplementation((stream, ...args) =>
        saveMediaStream(observeWrites(stream), ...args),
      );
      const saving = network.withStoreRemoteFixture({ url }, () =>
        buildAssistantReplyContent({
          sessionKey: "agent:main:reply-media-abort",
          payloads: [{ mediaUrls: [url] }],
          abortSignal: controller.signal,
          assertCurrent: () => controller.signal.throwIfAborted(),
        }),
      );
      const delivery = saving.catch((error: unknown) => error);
      try {
        await gates.withinTest(
          gates.awaitGateBeforeSettlement(
            firstWrite.promise,
            saving,
            "Reply settled before partial outgoing media was written",
          ),
          signal,
        );
        const directory = state.statePath("media", "outgoing", "originals");
        const stats = await Promise.all(
          (await fs.readdir(directory)).map((name) => fs.stat(path.join(directory, name))),
        );
        expect(stats.some((stat) => stat.isFile() && stat.size > 0)).toBe(true);
        controller.abort();
        await gates.withinTest(responseClosed.promise, signal);
        expect(await delivery).toMatchObject({ name: "AbortError" });
      } finally {
        await verifyCleanup(async () => {
          controller.abort();
          await httpFixture.closeHttpServer(upstream);
          await delivery;
          network.disposeStoreRemoteFixtures();
        });
      }
    }),
  ));

it("retains the resized image after replacing an owned staging file", () =>
  withOpenClawTestState({ label: "reply-media-resize" }, async (state) => {
    const source = state.workspaceDir + "/wide.png";
    const image = createSolidPngBuffer(5000, 32, { r: 80, g: 120, b: 160 });
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
  }));
