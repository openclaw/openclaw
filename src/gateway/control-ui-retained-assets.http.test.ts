import fsSync from "node:fs";
import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createControlUiAssetRetention,
  type ControlUiAssetRetention,
} from "./control-ui-asset-retention.js";
import {
  holdRetentionAssetRead,
  withRetentionFixture,
  writeRetentionBuild,
} from "./control-ui-asset-retention.test-support.js";
import { handleControlUiHttpRequest } from "./control-ui.js";
import { makeMockHttpResponse } from "./test-http-response.js";

const testTempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
});

async function runControlUiRequest(
  rootPath: string,
  url: string,
  options: { retainedAssets: ControlUiAssetRetention; headers?: IncomingMessage["headers"] },
) {
  const response = makeMockHttpResponse();
  const headers = options.headers ?? {};
  const request = {
    url,
    method: "GET",
    headers,
    headersDistinct: Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [
        name,
        Array.isArray(value) ? value : [String(value)],
      ]),
    ),
    socket: { remoteAddress: "127.0.0.1" },
  } as IncomingMessage;
  const handled = await handleControlUiHttpRequest(request, response.res, {
    root: { kind: "bundled", path: rootPath, retainedAssets: options.retainedAssets },
  });
  return { ...response, handled };
}

function responseBody(end: ReturnType<typeof makeMockHttpResponse>["end"]) {
  return String(end.mock.calls[0]?.[0] ?? "");
}

async function writeAssetFile(rootPath: string, filename: string, contents: string) {
  const assetsDir = path.join(rootPath, "assets");
  await fs.mkdir(assetsDir, { recursive: true });
  const filePath = path.join(assetsDir, filename);
  await fs.writeFile(filePath, contents);
  return { filePath };
}

describe("Control UI retained asset HTTP requests", () => {
  it("waits for retained inventory before serving a stale bundled asset", async ({ signal }) => {
    await withRetentionFixture(async ({ root, seed }) => {
      const prior = await seed("prior");
      const current = await writeRetentionBuild(path.join(root, "current"), "current");
      const retainedAssets = createControlUiAssetRetention(current.root);
      const gate = holdRetentionAssetRead(path.join(prior.target, prior.assetPath));
      const requested = createDeferred();
      const resolveAsset = retainedAssets.resolveAsset;
      vi.spyOn(retainedAssets, "resolveAsset").mockImplementation((assetPath) => {
        requested.resolve();
        return resolveAsset(assetPath);
      });
      await withEnvAsync({ FS_SAFE_NATIVE_MODE: "off" }, async () => {
        const preparing = retainedAssets.prepare();
        try {
          await withinTest(
            awaitGateBeforeSettlement(
              gate.entered,
              preparing,
              "Inventory did not read the prior asset",
            ),
            signal,
          );
          const response = runControlUiRequest(current.root, `/${prior.assetPath}`, {
            retainedAssets,
          });
          try {
            await withinTest(
              awaitGateBeforeSettlement(
                requested.promise,
                response,
                "Request did not reach retention",
              ),
              signal,
            );
          } finally {
            gate.release();
          }
          const { handled, res, end } = await response;
          expect(handled).toBe(true);
          expect(res.statusCode).toBe(200);
          expect(responseBody(end)).toBe('export const panel = "prior";\n');
        } finally {
          gate.release();
          await preparing;
        }
      });
    });
  });

  it("serves a missing bundled asset from an exact retained generation", async () => {
    const tmp = testTempDirs.make("openclaw-ui-");
    await fs.writeFile(path.join(tmp, "index.html"), "<html></html>\n");
    const retainedRoot = testTempDirs.make("openclaw-ui-retained-");
    const source = "console.log('retained');\n".repeat(200);
    const { filePath } = await writeAssetFile(retainedRoot, "panel-OldBuild.js", source);
    await fs.writeFile(`${filePath}.br`, brotliCompressSync(source));
    const retainedAssets = {
      prepare: vi.fn(async () => {}),
      resolveAsset: vi.fn(async () => ({
        filePath,
        rootPath: retainedRoot,
        rootRealPath: fsSync.realpathSync(retainedRoot),
      })),
    } satisfies ControlUiAssetRetention;

    const { end, setHeader } = await runControlUiRequest(tmp, "/assets/panel-OldBuild.js", {
      retainedAssets,
      headers: { "accept-encoding": "br, identity;q=0" },
    });

    expect(retainedAssets.resolveAsset).toHaveBeenCalledWith("assets/panel-OldBuild.js");
    expect(setHeader).toHaveBeenCalledWith("Content-Encoding", "br");
    expect(brotliDecompressSync(end.mock.calls[0]?.[0] as Buffer).toString()).toBe(source);
  });
});
