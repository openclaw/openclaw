import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const checkout = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);
const uiRequire = createRequire(path.join(checkout, "ui/package.json"));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function prepareFixture() {
  const root = tempDirs.make("vitest-security-cohort-");
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ type: "module", workspaces: [] }),
  );
  fs.symlinkSync(path.join(checkout, "node_modules"), path.join(root, "node_modules"), "junction");
  return root;
}

const fixtureDirectories = [
  "HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
] as const;

function runNode(root: string, args: string[], inheritedEnv = process.env) {
  const env: NodeJS.ProcessEnv = { ...inheritedEnv, CI: "1" };
  for (const key of fixtureDirectories) {
    const directory = path.join(root, "environment", key);
    fs.mkdirSync(directory, { recursive: true });
    env[key] = directory;
  }
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    env,
    timeout: 15_000,
  });
  expect(result.status, String(result.error ?? "") + result.stdout + result.stderr).toBe(0);
  if (process.env.OPENCLAW_VITEST_SECURITY_TRACE === "1") {
    console.log(
      result.stdout
        .split("\n")
        .filter((line) => line.startsWith("SECURITY_TRACE "))
        .join("\n"),
    );
  }
  return result;
}

it("isolates persistent tokens from hostile inherited platform directories", () => {
  const root = prepareFixture();
  const outside = tempDirs.make("vitest-hostile-environment-");
  const inheritedEnv = { ...process.env };
  for (const key of fixtureDirectories) {
    inheritedEnv[key] = outside;
  }
  const token = path.join(outside, "vitest", ".vitest-secret-token");
  fs.mkdirSync(path.dirname(token), { recursive: true });
  fs.writeFileSync(token, "synthetic-outside-token");
  runNode(
    root,
    [
      "--input-type=module",
      "--eval",
      `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import path from "node:path";
    import { createVitest } from "vitest/node";
    for (const key of ${JSON.stringify(fixtureDirectories)}) {
      assert.equal(process.env[key], path.join(process.cwd(), "environment", key));
    }
    const ctx = await createVitest("test", { root: process.cwd(), config: false, watch: false });
    try {
      assert.notEqual(ctx.config.api.token, "synthetic-outside-token");
      const dataRoot = process.platform === "win32" ? process.env.LOCALAPPDATA
        : process.platform === "darwin" ? path.join(process.env.HOME, "Library/Application Support")
        : process.env.XDG_DATA_HOME;
      assert.equal(fs.readFileSync(path.join(dataRoot, "vitest", ".vitest-secret-token"), "utf8").trim(), ctx.config.api.token);
      console.log('SECURITY_TRACE {"boundary":"fixture-token","inheritedTokenUsed":false,"persistedInsideFixture":true}');
    } finally { await ctx.close(); }
  `,
    ],
    inheritedEnv,
  );
  expect(fs.readFileSync(token, "utf8")).toBe("synthetic-outside-token");
  expect(fs.readdirSync(outside)).toEqual(["vitest"]);
  expect(fs.readdirSync(path.dirname(token))).toEqual([".vitest-secret-token"]);
});

it("keeps the core, browser, UI, and V8 coverage packages on one version", () => {
  const version = require("vitest/package.json").version;
  const vitestRequire = createRequire(uiRequire.resolve("vitest/package.json"));
  for (const [resolver, name] of [
    [require, "@vitest/coverage-v8"],
    [uiRequire, "vitest"],
    [uiRequire, "@vitest/browser"],
    [uiRequire, "@vitest/browser-playwright"],
    [vitestRequire, "@vitest/ui"],
    [vitestRequire, "@vitest/mocker"],
  ] as const) {
    expect(resolver(name + "/package.json").version, name).toBe(version);
  }
});

it("serves authenticated UI assets while denying private files on root and browser project servers", () => {
  const root = prepareFixture();
  fs.writeFileSync(path.join(root, "server.pem"), "private-key-canary");
  fs.writeFileSync(path.join(root, ".env"), 'SECURITY_CANARY="not-served"');
  fs.writeFileSync(path.join(root, ".vitest-secret-token"), "not-a-real-token");
  fs.writeFileSync(path.join(root, "public.js"), "export const value = 42;");
  const result = runNode(root, [
    "--input-type=module",
    "--eval",
    `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(
  ${JSON.stringify(path.join(checkout, "ui/package.json"))}
);
const { createVitest } = await import(pathToFileURL(require.resolve("vitest/node")));
const { playwright } = await import(pathToFileURL(require.resolve("@vitest/browser-playwright")));
let ctx;
try {
  ctx = await createVitest("test", {
    root: process.cwd(),
    config: false,
    watch: false,
    ui: true,
    open: false,
    api: { host: "127.0.0.1", port: 0 },
    projects: [{
      extends: false,
      root: process.cwd(),
      test: {
        name: "browser-security",
        api: { host: "127.0.0.1", port: 0 },
        browser: {
          enabled: true,
          headless: true,
          provider: playwright(),
          instances: [{ browser: "chromium" }],
        },
      },
    }],
  });
  const servers = [["root-ui", ctx.vite], ...ctx.projects.map(p => [p.name, p.vite])];
  assert.equal(servers.length, 2);
  for (const [name, server] of servers) {
    if (!server.httpServer?.listening) await server.listen(0);
    const base = "http://127.0.0.1:" + server.httpServer.address().port;
    const publicResponse = await fetch(base + "/public.js");
    assert.equal(publicResponse.status, 200);
    assert.match(await publicResponse.text(), /value = 42/);
    console.log("SECURITY_TRACE " + JSON.stringify({ server: name, request: "/public.js", status: publicResponse.status, allowedContent: true }));
    for (const file of [".env?raw", "server.pem?raw", ".vitest-secret-token?raw"]) {
      const response = await fetch(base + "/" + file);
      const body = await response.text();
      assert.equal(response.status, 403, name + ": " + file);
      assert.ok(!body.includes("not-served") && !body.includes("not-a-real-token") && !body.includes("private-key-canary"));
      console.log("SECURITY_TRACE " + JSON.stringify({ server: name, request: "/" + file, status: response.status, secretAbsent: true }));
    }
    if (name === "root-ui") {
      const unauthenticated = await fetch(base + "/__vitest__/");
      assert.equal(unauthenticated.status, 403);
      await unauthenticated.text();
      console.log('SECURITY_TRACE {"boundary":"ui","auth":"none","status":403}');
      const bootstrap = await fetch(
        base + "/__vitest__/?token=" + encodeURIComponent(ctx.config.api.token),
        { redirect: "manual" },
      );
      assert.equal(bootstrap.status, 302);
      const cookie = bootstrap.headers.get("set-cookie").split(";")[0];
      const response = await fetch(base + "/__vitest__/", { headers: { cookie } });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /html/i);
      console.log('SECURITY_TRACE {"boundary":"ui","auth":"fixture-cookie","status":200,"html":true}');
      ctx.config.api.token = "synthetic-replacement-api-token";
      const stale = await fetch(base + "/__vitest__/", { headers: { cookie } });
      const staleBody = await stale.text();
      assert.equal(stale.status, 403);
      assert.doesNotMatch(staleBody, /<html/i);
      console.log('SECURITY_TRACE {"boundary":"ui","auth":"old-cookie-after-token-replacement","status":403,"html":false}');
      const replacement = await fetch(base + "/__vitest__/?token=" + encodeURIComponent(ctx.config.api.token), { redirect: "manual" });
      assert.equal(replacement.status, 302);
      const replacementCookie = replacement.headers.get("set-cookie").split(";")[0];
      const current = await fetch(base + "/__vitest__/", { headers: { cookie: replacementCookie } });
      assert.equal(current.status, 200);
      assert.match(await current.text(), /html/i);
      console.log('SECURITY_TRACE {"boundary":"ui","auth":"replacement-cookie","status":200,"html":true}');
    }
  }
  console.log("private-file checks passed on 2 servers");
} finally {
  await ctx?.close();
}
`,
  ]);
  expect(result.stdout).toContain("private-file checks passed on 2 servers");
});

it("rejects WebSocket redirect escapes and safely executes hostile manual mock exports", () => {
  const root = prepareFixture();
  const outside = tempDirs.make("vitest-mocker-denied-");
  fs.writeFileSync(path.join(outside, "secret.js"), "export const secret = 'outside-file-canary';");
  fs.writeFileSync(path.join(root, "allowed.js"), "export const original = true;");
  fs.writeFileSync(path.join(root, "denied.js"), "export const fallback = true;");
  fs.writeFileSync(path.join(root, "manual.js"), "export const original = true;");
  fs.writeFileSync(path.join(root, "redirect.js"), "export const redirected = 42;");
  runNode(root, [
    "--input-type=module",
    "--eval",
    `
    import assert from "node:assert/strict";
    import path from "node:path";
    import { createRequire } from "node:module";
    import { pathToFileURL } from "node:url";
    const require = createRequire(path.join(process.cwd(), "package.json"));
    const vr = createRequire(require.resolve("vitest/package.json"));
    const { interceptorPlugin } = await import(pathToFileURL(vr.resolve("@vitest/mocker/node")));
    const { MockerRegistry } = await import(pathToFileURL(vr.resolve("@vitest/mocker")));
    const { createServer } = await import(pathToFileURL(require.resolve("vite")));
    const { WebSocket } = require("ws");
    const registry = new MockerRegistry();
    const server = await createServer({
      root: process.cwd(), configFile: false,
      server: { host: "127.0.0.1", port: 0, fs: { strict: true, allow: [process.cwd()] } },
      plugins: [interceptorPlugin({ registry })],
    });
    let ws;
    try {
      await server.listen();
      const base = "http://127.0.0.1:" + server.httpServer.address().port;
      ws = new WebSocket(base.replace("http:", "ws:") + "/?token=" + server.config.webSocketToken, "vite-hmr");
      await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
      function receive(event) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("missing event " + event)), 3000);
          function listener(raw) {
            const message = JSON.parse(raw.toString());
            if (message.type === "custom" && message.event === event) {
              clearTimeout(timer); ws.off("message", listener); resolve(message.data);
            }
          }
          ws.on("message", listener);
        });
      }
      async function register(data) {
        const ack = receive("vitest:interceptor:register:result");
        ws.send(JSON.stringify({ type: "custom", event: "vitest:interceptor:register", data }));
        await ack;
      }
      await register({ type: "redirect", raw: "allowed", id: path.join(process.cwd(), "allowed.js"), url: "/allowed.js", redirect: "mock:/redirect.js" });
      const allowed = await fetch(base + "/allowed.js");
      assert.equal(allowed.status, 200);
      assert.match(await allowed.text(), /redirected = 42/);
      console.log('SECURITY_TRACE {"boundary":"mocker-websocket","request":"in-root-redirect","registered":true,"httpStatus":200,"allowedContent":true}');
      const escaped = "mock:/.." + String.fromCharCode(92) + path.basename(${JSON.stringify(outside)}) + "/secret.js";
      await register({ type: "redirect", raw: "denied", id: path.join(process.cwd(), "denied.js"), url: "/denied.js", redirect: escaped });
      assert.equal(registry.get("/denied.js"), undefined);
      const denied = await fetch(base + "/denied.js");
      const deniedBody = await denied.text();
      assert.equal(denied.status, 200);
      assert.match(deniedBody, /fallback = true/);
      assert.ok(!deniedBody.includes("outside-file-canary"));
      console.log('SECURITY_TRACE {"boundary":"mocker-websocket","request":"backslash-out-of-root-redirect","registered":false,"httpStatus":200,"fallbackOnly":true,"secretAbsent":true}');
      const hostile = String.fromCharCode(34) + ";globalThis.__securityCanary=true;//";
      const moduleUrl = "/manual" + hostile;
      ws.on("message", raw => {
        const message = JSON.parse(raw.toString());
        if (message.event === "vitest:interceptor:resolve") ws.send(JSON.stringify({ type: "custom", event: "vitest:interceptor:resolved", data: { url: message.data, keys: ["safe", hostile] } }));
      });
      await register({ type: "manual", raw: "manual", id: path.join(process.cwd(), "manual.js"), url: moduleUrl });
      const manual = await fetch(base + "/manual.js");
      assert.equal(manual.status, 200);
      const code = await manual.text();
      globalThis.__securityCanary = false;
      globalThis.__vitest_mocker__ = { getFactoryModule(url) { assert.equal(url, moduleUrl); return { safe: 42, [hostile]: 7 }; } };
      const evaluated = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
      assert.equal(evaluated.safe, 42);
      assert.equal(evaluated[hostile], 7);
      assert.equal(globalThis.__securityCanary, false);
      console.log('SECURITY_TRACE {"boundary":"mocker-websocket","request":"hostile-manual-url-and-export","registered":true,"httpStatus":200,"safeExport":42,"hostileExport":7,"injectedCodeExecuted":false}');
    } finally {
      ws?.terminate();
      await server.close();
    }
  `,
  ]);
});

it("runs the V8 coverage provider and emits instrumented source coverage", () => {
  const root = prepareFixture();
  fs.writeFileSync(path.join(root, "answer.js"), "export const answer = () => 42;");
  fs.writeFileSync(
    path.join(root, "answer.test.js"),
    'import { test, expect } from "vitest"; import { answer } from "./answer.js"; test("answer", () => expect(answer()).toBe(42));',
  );
  const config = path.join(root, "vitest.config.mjs");
  fs.writeFileSync(
    config,
    "export default " +
      JSON.stringify({
        root,
        test: {
          include: ["answer.test.js"],
          maxWorkers: 1,
          coverage: {
            enabled: true,
            provider: "v8",
            reporter: ["json"],
            include: ["answer.js"],
            reportsDirectory: "coverage",
          },
        },
      }),
  );
  runNode(root, [
    path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs"),
    "run",
    "--config",
    config,
  ]);
  const coverage = JSON.parse(
    fs.readFileSync(path.join(root, "coverage/coverage-final.json"), "utf8"),
  );
  const source = coverage[path.join(root, "answer.js")];
  expect(source).toBeDefined();
  expect(Object.values(source.s)).not.toHaveLength(0);
  expect(Object.values(source.s).every((hits) => typeof hits === "number" && hits > 0)).toBe(true);
});
