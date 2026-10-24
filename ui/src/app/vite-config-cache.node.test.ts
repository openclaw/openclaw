// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import controlUiViteConfig, {
  createControlUiPrecompressedAssetVariants,
  refreshControlUiBuildOutput,
} from "../../vite.config.ts";
import { normalizeControlUiBuildInfo } from "../build-info-normalizers.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

it("builds boot and deferred inventories before compression sidecars exist", async ({
  onTestFinished,
}) => {
  const output = await mkdtemp(path.join(os.tmpdir(), "openclaw-ui-inventory-"));
  onTestFinished(() => rm(output, { recursive: true, force: true }));
  await mkdir(path.join(output, "assets"));
  await writeFile(path.join(output, "index.html"), "<html><head></head></html>");
  const bootFile = "assets/index-AbCd1234.js";
  const deferredFile = "assets/__vite-browser-external-2447137e-CWgf1vdC.js";
  const source = "export const answer = 42;";
  for (const file of [bootFile, deferredFile]) {
    await writeFile(path.join(output, file), source);
  }

  const sizes = await refreshControlUiBuildOutput(
    output,
    normalizeControlUiBuildInfo({ version: "1.0.0", dirty: false, buildId: "inventory" }),
    [bootFile],
    false,
  );

  const worker = readFileSync(path.join(output, "sw.js"), "utf8");
  const offline = JSON.parse(worker.match(/^const OFFLINE_BOOT = (.+);$/mu)![1]!);
  const integrity = `sha256-${createHash("sha256").update(source).digest("base64")}`;
  expect(offline.assets).toEqual([{ path: bootFile, integrity }]);
  expect(offline.deferredAssets).toEqual([{ path: deferredFile, integrity }]);
  expect(sizes).toEqual({ count: 1, rawBytes: 25, gzipBytes: 45 });
  expect(readdirSync(path.join(output, "assets")).toSorted()).toEqual(
    [bootFile, deferredFile].map((file) => path.basename(file)).toSorted(),
  );
});

it("refreshes cached identity without changing compressed assets", async ({ onTestFinished }) => {
  const output = await mkdtemp(path.join(os.tmpdir(), "openclaw-ui-identity-"));
  onTestFinished(() => rm(output, { recursive: true, force: true }));
  const read = (file: string) => readFileSync(path.join(output, file), "utf8");
  const digest = (source: string) =>
    `sha256-${createHash("sha256").update(source).digest("base64")}`;
  await cp(path.join(repoRoot, "ui/public"), output, { recursive: true });
  await mkdir(path.join(output, "assets"));
  const assetName = "assets/app-content-hash.js";
  const source = "export const answer = 42;";
  const assets = [
    { fileName: assetName, source: Buffer.from(source) },
    ...(await createControlUiPrecompressedAssetVariants(assetName, source)),
  ];
  const deferredFiles = [
    "assets/session-actions-AbCd1234.js",
    "assets/session-organizer-operations.runtime-AbCd1234.js",
    "assets/session-actions-AbCd1234.css",
    "assets/en-settings-AbCd1234.js",
  ];
  const excludedFiles = [
    "assets/de-AbCd1234.js",
    "assets/locale-config-hints-zh-CN-AbCd1234.js",
    "assets/locale-namespace-fr-settings-AbCd1234.js",
    "assets/mermaid.min-AbCd1234.js",
    "assets/unhashed.js",
    "assets/session-actions-AbCd1234.js.map",
    "plugins/example/assets/plugin-AbCd1234.js",
  ];
  for (const fileName of [...deferredFiles, ...excludedFiles]) {
    await mkdir(path.dirname(path.join(output, fileName)), { recursive: true });
    assets.push(
      { fileName, source: Buffer.from(source) },
      ...(await createControlUiPrecompressedAssetVariants(fileName, source)),
    );
  }
  for (const asset of assets) {
    await writeFile(path.join(output, asset.fileName), asset.source);
  }
  await writeFile(path.join(output, "index.html"), "<html><head></head></html>");
  const first = normalizeControlUiBuildInfo({ version: "1.0.0", dirty: false, buildId: "first" });
  const second = {
    ...first,
    commit: "b".repeat(40),
    commitAt: "2026-10-12T10:00:00.000Z",
    builtAt: "2026-10-12T12:00:00.000Z",
    buildId: "second-build",
    branch: "branch-</script>",
  };
  const config = controlUiViteConfig({ command: "build", buildInfo: first });
  expect(config.define ?? {}).not.toHaveProperty("globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO");
  await refreshControlUiBuildOutput(output, first, [assetName]);
  const previousWorker = read("sw.js");
  await refreshControlUiBuildOutput(output, second);

  const html = read("index.html");
  const identityScript = html.match(
    /<script\b[^>]*\bid="openclaw-control-ui-build-info"[^>]*>(.*?)<\/script>/u,
  )?.[1];
  expect(identityScript).toBeDefined();
  expect(
    JSON.parse(identityScript!.slice("globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO=".length, -1)),
  ).toEqual(second);
  expect(html).not.toContain("branch-</script>");
  expect(html).not.toContain(first.buildId);
  const worker = read("sw.js");
  expect(worker).toContain('const EMBEDDED_CACHE_VERSION = "second-build";');
  const offline = JSON.parse(worker.match(/^const OFFLINE_BOOT = (.+);$/mu)![1]!);
  expect(offline).toMatchObject({
    routes: expect.arrayContaining(["/new", "/settings/connection", "/appearance", "/usage"]),
    routePrefixes: expect.arrayContaining(["/chat/", "/dashboard/", "/settings/agents/"]),
    html,
    csp: expect.stringContaining(digest(identityScript!)),
    assets: expect.arrayContaining([{ path: assetName, integrity: digest(source) }]),
    deferredAssets: deferredFiles
      .toSorted()
      .map((file) => ({ path: file, integrity: digest(source) })),
  });
  expect(offline.routes).not.toContain("/api");
  expect(offline.routePrefixes).not.toContain("/plugins/");
  expect(worker).not.toBe(previousWorker);
  for (const asset of assets) {
    expect(readFileSync(path.join(output, asset.fileName))).toEqual(asset.source);
  }
  const manifest: { icons: { src: string }[] } = JSON.parse(read("manifest.webmanifest"));
  for (const { src } of manifest.icons) {
    expect(src).toContain("?v=second-build-");
    expect(src.match(/\?v=/gu)).toHaveLength(1);
  }
  await refreshControlUiBuildOutput(output, second);
  expect(read("sw.js")).toBe(worker);
});
