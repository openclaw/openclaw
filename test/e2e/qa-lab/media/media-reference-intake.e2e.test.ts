import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { saveMediaBuffer } from "../../../../src/media/store.js";
import { loadWebMediaRaw } from "../../../../src/media/web-media.js";
import { withEnvAsync } from "../../../../src/test-utils/env.js";
import { createSolidPngBuffer } from "../../../helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { listen } from "./media-http.test-support.js";

describe("media reference intake product proof", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let server: Awaited<ReturnType<typeof listen>> | undefined;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
  });

  it("loads every supported reference and trusts PNG bytes over text hints", async () => {
    const root = tempDirs.make("openclaw-media-reference-intake-");
    const png = createSolidPngBuffer(2, 2, { r: 32, g: 96, b: 224 });
    const localPath = path.join(root, "misleading.txt");
    await fs.writeFile(localPath, png);

    const requestedPaths: string[] = [];
    server = await listen(
      createServer((request, response) => {
        requestedPaths.push(request.url ?? "");
        response.writeHead(200, {
          "content-disposition": 'attachment; filename="remote.txt"',
          "content-length": String(png.byteLength),
          "content-type": "text/plain",
        });
        response.end(png);
      }),
    );
    const remoteUrl = `${server.url}/misleading.txt`;

    await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(root, "state") }, async () => {
      const stored = await saveMediaBuffer(png, "text/plain", "inbound", 1024 * 1024, "stored.txt");
      expect(stored.contentType).toBe("image/png");
      expect(stored.id).toMatch(/\.txt$/);

      const plainPath = await loadWebMediaRaw(localPath, {
        localRoots: [root],
        maxBytes: 1024 * 1024,
      });
      const fileUrl = await loadWebMediaRaw(pathToFileURL(localPath).toString(), {
        localRoots: [root],
        maxBytes: 1024 * 1024,
      });
      const remote = await loadWebMediaRaw(remoteUrl, {
        maxBytes: 1024 * 1024,
        ssrfPolicy: { allowedHostnames: ["127.0.0.1"] },
      });
      const mediaStore = await loadWebMediaRaw(`media://inbound/${stored.id}`, {
        maxBytes: 1024 * 1024,
      });

      for (const result of [plainPath, fileUrl, remote, mediaStore]) {
        expect(result.buffer).toEqual(png);
        expect(result.contentType).toBe("image/png");
        expect(result.kind).toBe("image");
      }

      expect(plainPath.fileName).toBe("misleading.txt");
      expect(fileUrl.fileName).toBe("misleading.txt");
      expect(remote.fileName).toBe("remote.txt");
      expect(requestedPaths).toEqual(["/misleading.txt"]);
    });
  });
});
