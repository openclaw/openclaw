import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MediaFetchError, saveRemoteMedia } from "../../../../src/media/fetch.js";
import { withEnvAsync } from "../../../../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { listen } from "./media-http.test-support.js";

type SeenRequest = IncomingMessage["headers"];

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sourceRequests: SeenRequest[] = [];
const targetRequests: SeenRequest[] = [];

let sourceServer: Awaited<ReturnType<typeof listen>>;
let sourceOrigin: string;
let targetServer: Awaited<ReturnType<typeof listen>>;
let targetOrigin: string;

function handleSourceRequest(request: IncomingMessage, response: ServerResponse): void {
  sourceRequests.push(request.headers);
  switch (request.url) {
    case "/private":
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("private media");
      return;
    case "/redirect":
      response.writeHead(302, { location: `${targetOrigin}/payload` });
      response.end();
      return;
    case "/oversized-file":
      response.writeHead(200, {
        "content-length": "128",
        "content-type": "application/octet-stream",
      });
      response.end("declared oversized file");
      return;
    case "/oversized-stream":
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.write(Buffer.alloc(12, 0x61));
      response.end(Buffer.alloc(12, 0x62));
      return;
    default:
      response.writeHead(404);
      response.end();
  }
}

function handleTargetRequest(request: IncomingMessage, response: ServerResponse): void {
  targetRequests.push(request.headers);
  if (request.url !== "/payload") {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("redirected media");
}

async function expectNoPublishedMediaFiles(stateDir: string): Promise<void> {
  const entries = await fs
    .readdir(path.join(stateDir, "media"), {
      withFileTypes: true,
      recursive: true,
    })
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    });
  expect(entries.filter((entry) => !entry.isDirectory())).toStrictEqual([]);
}

describe("media guarded fetch product boundaries", () => {
  beforeAll(async () => {
    targetServer = await listen(createServer(handleTargetRequest));
    targetOrigin = targetServer.url;
    sourceServer = await listen(createServer(handleSourceRequest));
    sourceOrigin = sourceServer.url;
  });

  beforeEach(() => {
    sourceRequests.length = 0;
    targetRequests.length = 0;
  });

  afterAll(async () => {
    await Promise.all([sourceServer.stop(), targetServer.stop()]);
  });

  it("rejects private targets before the network or media store is reached", async () => {
    const stateDir = tempDirs.make("openclaw-media-private-fetch-");

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const error = await saveRemoteMedia({
        url: `${sourceOrigin}/private`,
        maxBytes: 64,
        subdir: "private-target",
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(MediaFetchError);
      expect(error).toMatchObject({
        code: "fetch_failed",
        cause: { name: "SsrFBlockedError" },
      });
      expect(sourceRequests).toHaveLength(0);
      await expectNoPublishedMediaFiles(stateDir);
    });
  });

  it("revalidates redirect targets and strips sensitive cross-origin headers", async () => {
    const stateDir = tempDirs.make("openclaw-media-safe-redirect-");
    const redirect = (subdir: string, allowedOrigins: string[]) =>
      saveRemoteMedia({
        url: `${sourceOrigin}/redirect`,
        requestInit: {
          headers: {
            Accept: "text/plain",
            Authorization: "Bearer private-token",
            Cookie: "session=private",
            "X-Api-Key": "private-key",
          },
        },
        maxBytes: 64,
        subdir,
        ssrfPolicy: { allowedOrigins },
      });

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const blocked = await redirect("blocked-redirect", [sourceOrigin]).catch(
        (caught: unknown) => caught,
      );

      expect(blocked).toBeInstanceOf(MediaFetchError);
      expect(blocked).toMatchObject({
        code: "fetch_failed",
        cause: { name: "SsrFBlockedError" },
      });
      expect(sourceRequests).toHaveLength(1);
      expect(targetRequests).toHaveLength(0);
      await expectNoPublishedMediaFiles(stateDir);

      sourceRequests.length = 0;
      const saved = await redirect("safe-redirect", [sourceOrigin, targetOrigin]);

      expect(sourceRequests[0]?.authorization).toBe("Bearer private-token");
      expect(targetRequests).toHaveLength(1);
      expect(targetRequests[0]).toMatchObject({ accept: "text/plain" });
      expect(
        ["authorization", "cookie", "x-api-key"].map((key) => targetRequests[0]?.[key]),
      ).toEqual([undefined, undefined, undefined]);
      await expect(fs.readFile(saved.path, "utf8")).resolves.toBe("redirected media");
    });
  });

  it("rejects declared and streamed overflows without publishing store artifacts", async () => {
    const stateDir = tempDirs.make("openclaw-media-bounded-fetch-");
    const allowedOrigins = [sourceOrigin];

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      for (const subdir of ["oversized-file", "oversized-stream"]) {
        await expect(
          saveRemoteMedia({
            url: `${sourceOrigin}/${subdir}`,
            maxBytes: 16,
            subdir,
            ssrfPolicy: { allowedOrigins },
          }),
        ).rejects.toMatchObject({ name: "MediaFetchError", code: "max_bytes" });
        await expectNoPublishedMediaFiles(stateDir);
      }
    });
  });
});
