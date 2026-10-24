// Requested-file accounting for finalized production bundles, not HTTP transfer or latency.
// Run: node --import ./scripts/tsx.mjs ui/scripts/measure-boot-workload.mts <dist>
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { selectControlUiRoutePreloads } from "../../src/gateway/control-ui-route-preloads.ts";
import { normalizeControlUiBuildInfo } from "../src/build-info-normalizers.ts";
import {
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
} from "../src/test-helpers/control-ui-e2e.ts";

const dist = fs.realpathSync(process.argv[2] ?? "dist/control-ui");
const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
const build = normalizeControlUiBuildInfo(
  JSON.parse(html.match(/globalThis\.OPENCLAW_CONTROL_UI_BUILD_INFO=(\{.*?\});<\/script>/su)![1]!),
);
const mime: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (pathname === "/control-ui-config.json") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ basePath: "/", assistantName: "", assistantAvatar: "" }));
    return;
  }
  const file = path.resolve(dist, `.${pathname}`);
  if (!file.startsWith(`${dist}${path.sep}`)) {
    res.writeHead(404).end();
    return;
  }
  if (fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
    res.setHeader("Content-Type", mime[path.extname(file)] ?? "application/octet-stream");
    res.end(fs.readFileSync(file));
    return;
  }
  res.setHeader("Content-Type", "text/html");
  res.end(
    selectControlUiRoutePreloads(html, pathname.startsWith("/new") ? "new" : "chat")
      .replaceAll('src="./assets/', 'src="/assets/')
      .replaceAll('href="./assets/', 'href="/assets/'),
  );
});
await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert(address && typeof address === "object");
let browser: Browser | undefined;
const results: unknown[] = [];
function emittedAssets(directory = dist): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory()
      ? emittedAssets(file)
      : /\.(js|css)$/u.test(entry.name)
        ? [path.relative(dist, file)]
        : [];
  });
}
function count(files: Iterable<string>) {
  const assets = [...files].toSorted().map((file) => {
    const body = fs.readFileSync(path.join(dist, file));
    const size = (suffix: string) =>
      fs.statSync(path.join(dist, file + suffix), { throwIfNoEntry: false })?.size ?? body.length;
    return {
      file,
      raw: body.length,
      gzip: size(".gz"),
      brotli: size(".br"),
      sha256: createHash("sha256").update(body).digest("hex"),
    };
  });
  const sum = (extension: string) =>
    assets
      .filter(({ file }) => file.endsWith(extension))
      .reduce(
        (total, asset) => ({
          requests: total.requests + 1,
          raw: total.raw + asset.raw,
          gzip: total.gzip + asset.gzip,
          brotli: total.brotli + asset.brotli,
        }),
        { requests: 0, raw: 0, gzip: 0, brotli: 0 },
      );
  return { js: sum(".js"), css: sum(".css"), assets };
}
try {
  browser = await chromium.launch({
    executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
  });
  for (const route of ["new", "chat"] as const) {
    for (const admission of ["cold", "credential-reload"] as const) {
      const context = await browser.newContext({ serviceWorkers: "block" });
      try {
        const page = await context.newPage();
        const files = new Set<string>();
        const errors: string[] = [];
        page.on("request", (request) => {
          const pathname = new URL(request.url()).pathname;
          if (pathname.startsWith("/assets/") && /\.(js|css)$/u.test(pathname)) {
            files.add(pathname.slice(1));
          }
        });
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("requestfailed", (request) =>
          errors.push(`${request.url()}: ${request.failure()?.errorText}`),
        );
        await installMockGateway(page, { serverBuildId: build.buildId, awaitInitialRoster: false });
        const composer = page.locator(
          route === "chat"
            ? ".agent-chat__composer-combobox textarea"
            : ".new-session-page__message",
        );
        const ready = async () => {
          await composer.waitFor({ timeout: 60_000 });
          await page.waitForTimeout(3_000);
        };
        await page.goto(
          `http://127.0.0.1:${address.port}/${route}${admission === "cold" ? "" : "#token=synthetic-byte-workload"}`,
          { waitUntil: "commit" },
        );
        await ready();
        if (admission === "credential-reload") {
          await page.waitForFunction(() =>
            Object.keys(localStorage).some((key) =>
              key.startsWith("openclaw.control.bootRecord.v1:"),
            ),
          );
          await page.reload();
          await ready();
        }
        const boot = count(files);
        await composer.fill("Ordinary draft input");
        await page.waitForTimeout(1_000);
        assert.equal(await composer.inputValue(), "Ordinary draft input");
        assert.equal(await composer.isEnabled(), true);
        assert.deepEqual(errors, []);
        results.push({ route, admission, boot, firstInput: count(files) });
      } finally {
        await context.close();
      }
    }
  }
  console.log(
    JSON.stringify(
      {
        dist,
        build,
        host: { node: process.version, cpus: os.availableParallelism(), load: os.loadavg() },
        note: "Unique requested-file gzip/Brotli-or-identity accounting; synthetic RPC, HTTP identity responses, service workers blocked. Credential-reload is a separate admission path, not a warm-transfer timing measurement.",
        total: count(emittedAssets()),
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
