// External catalog transport simulation only: official route identity and all
// model/auth decisions stay in production. This shim never sends a commercial fetch.
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isMainThread, threadId } from "node:worker_threads";

const fixture = new URL(new URL(import.meta.url).searchParams.get("fixture"));
if (
  fixture.protocol !== "http:" ||
  fixture.hostname !== "127.0.0.1" ||
  fixture.username ||
  fixture.password
) {
  throw new Error("P8 catalog fixture requires credential-free loopback HTTP");
}
// The real catalog worker clears inherited execArgv. Carry only this external-I/O
// fixture into that exact built entry; retain its environment, authority, and transport.
if (isMainThread) {
  // Synthetic operator provisioning into the actual child state before registration.
  // This is file staging, not a catalog/availability or native-client override.
  const source = new URL(import.meta.url).searchParams.get("provisioning");
  if (source) {
    const directory = path.join(process.env.OPENCLAW_STATE_DIR, "worker-provisioning", "codex");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const helperPath = path.join(source, "token.mjs");
    fs.writeFileSync(path.join(directory, "token.mjs"), fs.readFileSync(helperPath), {
      mode: 0o600,
    });
    fs.writeFileSync(
      path.join(directory, "config.toml"),
      fs
        .readFileSync(path.join(source, "config.toml"), "utf8")
        .replace(helperPath, path.join(directory, "token.mjs")),
      { mode: 0o600 },
    );
  }
  const workers = createRequire(import.meta.url)("node:worker_threads");
  const Worker = workers.Worker;
  const catalogWorker = new URL(
    "../../../../dist/agents/prepared-model-catalog.worker.js",
    import.meta.url,
  ).href;
  workers.Worker = class extends Worker {
    constructor(filename, options) {
      const entry = filename instanceof URL ? filename.href : pathToFileURL(filename).href;
      super(
        filename,
        entry === catalogWorker
          ? {
              ...options,
              execArgv: [
                ...(options?.execArgv ?? process.execArgv),
                process.versions.bun ? "--preload" : "--import",
                import.meta.url,
              ],
            }
          : options,
      );
    }
  };
  syncBuiltinESMExports();
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const route =
    method === "GET" && url.href === "https://api.openai.com/v1/models"
      ? "/platform/models"
      : method === "GET" &&
          url.origin === "https://chatgpt.com" &&
          url.pathname === "/backend-api/codex/models" &&
          url.searchParams.size === 1 &&
          Boolean(url.searchParams.get("client_version"))
        ? "/platform/access-programs"
        : undefined;
  if (!route) {
    if (method === "GET" && url.href === "https://clawhub.ai/v1/feeds/plugins") {
      // Optional plugin discovery is outside this model proof. Preserve its real
      // unavailable/fallback path; never fabricate a trusted plugin feed.
      console.info("P8_BLOCKED_OPTIONAL_PLUGIN_FEED");
      throw new Error("P8 offline fixture: optional hosted plugin feed unavailable");
    }
    if (
      ["http:", "https:"].includes(url.protocol) &&
      ["127.0.0.1", "[::1]"].includes(url.hostname)
    ) {
      return originalFetch(input, init);
    }
    console.error("P8_UNEXPECTED_REMOTE_FETCH", method, url.origin, url.pathname);
    throw new Error("P8 catalog fixture refused an unmodeled non-loopback request");
  }
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  headers.set("x-p8-catalog-carrier", isMainThread ? "gateway" : "worker:" + threadId);
  headers.set("x-p8-catalog-runtime", process.versions.bun ? "bun" : "node");
  const fixtureInit = { ...init, headers };
  delete fixtureInit.dispatcher;
  const target = new URL(route, fixture);
  return originalFetch(input instanceof Request ? new Request(target, input) : target, fixtureInit);
};
// Existing hermetic fetch contract: host/IP and live effect authority still run;
// external DNS/TLS/dispatcher behavior is deliberately not part of this fixture.
globalThis.fetch.mock = {};
