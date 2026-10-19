// @vitest-environment node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import controlUiViteConfig, {
  createControlUiPrecompressedAssetVariants,
  refreshControlUiBuildOutput,
  resolveControlUiBuildInfo,
} from "../../vite.config.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("Control UI cached output identity", () => {
  it("refreshes a reused build's document and offline identity without changing compressed assets", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "openclaw-ui-identity-"));
    try {
      await cp(path.join(repoRoot, "ui/public"), output, { recursive: true });
      await mkdir(path.join(output, "assets"));
      const assetName = "assets/app-content-hash.js";
      const source = "export const answer = 42;";
      const assets = [
        { fileName: assetName, source: Buffer.from(source) },
        ...(await createControlUiPrecompressedAssetVariants(assetName, source)),
      ];
      for (const asset of assets) {
        await writeFile(path.join(output, asset.fileName), asset.source);
      }
      await writeFile(
        path.join(output, "index.html"),
        `<!doctype html><html><head></head><body><script type="module" src="./${assetName}"></script></body></html>`,
      );
      const first = resolveControlUiBuildInfo({
        env: { GIT_COMMIT: "a".repeat(40), OPENCLAW_BUILD_TIMESTAMP: "2026-10-11T12:00:00Z" },
        readPackageVersion: () => "2026.10.11",
        readGitCommitTimestamp: () => "2026-10-11T10:00:00Z",
        readGitBranch: () => "main",
        readGitDirty: () => false,
      });
      const second = {
        ...first,
        commit: "b".repeat(40),
        commitAt: "2026-10-12T10:00:00.000Z",
        builtAt: "2026-10-12T12:00:00.000Z",
        buildId: "second-build",
        branch: "branch-</script>",
      };
      expect(
        controlUiViteConfig({ command: "build", buildInfo: first }).define?.[
          "globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO"
        ],
      ).toBeUndefined();
      await refreshControlUiBuildOutput(output, first, [assetName]);
      const previousWorker = readFileSync(path.join(output, "sw.js"), "utf8");
      await refreshControlUiBuildOutput(output, second);

      const html = readFileSync(path.join(output, "index.html"), "utf8");
      const identityScript = html.match(
        /<script\b[^>]*\bid="openclaw-control-ui-build-info"[^>]*>(.*?)<\/script>/u,
      )?.[1];
      expect(identityScript).toBeDefined();
      expect(
        JSON.parse(identityScript!.slice("globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO=".length, -1)),
      ).toEqual(second);
      expect(html).not.toContain("branch-</script>");
      expect(html).not.toContain(first.buildId);
      const worker = readFileSync(path.join(output, "sw.js"), "utf8");
      expect(worker).toContain('const EMBEDDED_CACHE_VERSION = "second-build";');
      const encodedOffline = worker.match(/^const OFFLINE_BOOT = (.+);$/mu)?.[1];
      assert.ok(encodedOffline, "service worker must contain the offline build inventory");
      const offline = JSON.parse(encodedOffline);
      expect(offline.routes).toEqual(
        expect.arrayContaining(["/new", "/settings/connection", "/appearance", "/usage"]),
      );
      expect(offline.routes).not.toContain("/api");
      expect(offline.routePrefixes).toEqual(
        expect.arrayContaining(["/chat/", "/dashboard/", "/settings/agents/"]),
      );
      expect(offline.routePrefixes).not.toContain("/plugins/");
      expect(offline.html).toBe(html);
      expect(offline.csp).toContain(
        `sha256-${createHash("sha256").update(identityScript!).digest("base64")}`,
      );
      expect(offline.assets).toContainEqual({
        path: assetName,
        integrity: `sha256-${createHash("sha256").update(source).digest("base64")}`,
      });
      expect(worker).not.toBe(previousWorker);
      for (const asset of assets) {
        expect(readFileSync(path.join(output, asset.fileName))).toEqual(asset.source);
      }
      const manifest = JSON.parse(readFileSync(path.join(output, "manifest.webmanifest"), "utf8"));
      expect(
        manifest.icons.every(
          (icon: { src: string }) =>
            icon.src.includes("?v=second-build-") &&
            !icon.src.includes("?v=", icon.src.indexOf("?v=") + 1),
        ),
      ).toBe(true);
      const refreshedWorker = worker;
      await refreshControlUiBuildOutput(output, second);
      expect(readFileSync(path.join(output, "sw.js"), "utf8")).toBe(refreshedWorker);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });
});
