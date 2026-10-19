/* @vitest-environment node */

import fs from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { get, type ServerResponse } from "node:http";
import path from "node:path";
import { preview } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createControlUiE2eBuildPublication } from "../test-helpers/control-ui-e2e-build-publication.ts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function requestAsset(url: string) {
  const completion = createDeferred<{ status: number | undefined; body: string }>();
  const request = get(url, { headers: { accept: "application/javascript" } }, (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.once("error", completion.reject);
    response.once("end", () => {
      completion.resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() });
    });
  });
  request.once("error", completion.reject);
  return {
    request,
    completed: completion.promise.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    ),
  };
}

describe("Control UI preview build publication", () => {
  it.each(["complete", "cancel", "rollback"] as const)(
    "drains a held file open and resumes queued requests after %s",
    async (outcome) => {
      const root = tempDirs.make("openclaw-preview-publication-");
      const outDir = path.join(root, "served");
      const nextDir = path.join(root, "next");
      const previousDir = path.join(root, "previous");
      const oldAsset = path.join(outDir, "assets/old-hash.js");
      for (const directory of [outDir, nextDir]) {
        await mkdir(path.join(directory, "assets"), { recursive: true });
        await mkdir(path.join(directory, "fonts"), { recursive: true });
      }
      await writeFile(oldAsset, "old asset");
      await writeFile(path.join(nextDir, "assets/new-hash.js"), "new asset");
      await writeFile(path.join(outDir, "fonts/fixture.woff2"), "old font");
      await writeFile(path.join(nextDir, "fonts/fixture.woff2"), "new font");
      const publication = createControlUiE2eBuildPublication(outDir);
      const server = await preview({
        configFile: false,
        root,
        build: { outDir },
        preview: { host: "127.0.0.1", port: 0, strictPort: true },
        plugins: [publication.plugin],
      });
      const address = server.httpServer.address();
      if (!address || typeof address === "string") {
        throw new Error("Preview did not expose a TCP port");
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const originalOpen = fs.open;
      const openStarted = createDeferred();
      let intercepted = false;
      let continueOpen: (() => void) | undefined;
      const releaseOpen = () => {
        const pending = continueOpen;
        continueOpen = undefined;
        pending?.();
      };
      const openSpy = vi.spyOn(fs, "open").mockImplementation((...args) => {
        if (String(args[0]) === oldAsset && !intercepted) {
          intercepted = true;
          continueOpen = () => originalOpen(...args);
          openStarted.resolve();
          return;
        }
        originalOpen(...args);
      });
      const requests: ReturnType<typeof requestAsset>[] = [];
      let replacement: Promise<unknown> | undefined;
      try {
        const responseStarted = createDeferred<ServerResponse>();
        server.httpServer.once("request", (_request, response) =>
          responseStarted.resolve(response),
        );
        const original = requestAsset(`${baseUrl}/assets/old-hash.js`);
        requests.push(original);
        const response = await responseStarted.promise;
        await openStarted.promise;
        let replaced = false;
        replacement = publication
          .replaceBuild(outcome === "rollback" ? path.join(root, "missing") : nextDir, previousDir)
          .then(
            () => {
              replaced = true;
            },
            (error: unknown) => error,
          );
        const queuedRequest = createDeferred();
        server.httpServer.once("request", () => queuedRequest.resolve());
        const queued = requestAsset(`${baseUrl}/fonts/fixture.woff2`);
        requests.push(queued);
        await queuedRequest.promise;
        if (outcome === "cancel") {
          const closed = createDeferred();
          response.once("close", () => closed.resolve());
          const cancellation = new Error("Cancel the held asset request");
          original.request.destroy(cancellation);
          await closed.promise;
          expect(await original.completed).toEqual({ error: cancellation });
        }
        expect(replaced).toBe(false);
        expect(await readFile(oldAsset, "utf8")).toBe("old asset");
        releaseOpen();
        if (outcome !== "cancel") {
          expect(await original.completed).toEqual({ result: { status: 200, body: "old asset" } });
        }
        if (outcome === "rollback") {
          expect(await replacement).toMatchObject({
            code: "ENOENT",
            path: path.join(root, "missing"),
          });
        } else {
          expect(await replacement).toBeUndefined();
        }
        expect(await queued.completed).toEqual({
          result: { status: 200, body: outcome === "rollback" ? "old font" : "new font" },
        });
        const oldHash = requestAsset(`${baseUrl}/assets/old-hash.js`);
        requests.push(oldHash);
        expect(await oldHash.completed).toMatchObject({
          result: { status: outcome === "rollback" ? 200 : 404 },
        });
      } finally {
        releaseOpen();
        for (const { request } of requests) {
          request.destroy();
        }
        await Promise.allSettled([replacement, ...requests.map(({ completed }) => completed)]);
        openSpy.mockRestore();
        await server.close();
      }
    },
  );
});
