// Raw external-I/O fixture shared by the real CLI and its gh subprocesses.
// No release owner is replaced: all authentication and archive checks run in CLI.
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const callsite = () =>
  new Error().stack
    ?.split("\n")
    .filter((line) => line.includes("/scripts/") && !line.includes("/test/"))
    .slice(0, 4)
    .join("\n");
function record(value) {
  appendFileSync(
    process.env.NPM_CLI_REQUEST_LOG,
    JSON.stringify({
      invocation: process.env.NPM_CLI_INVOCATION,
      pid: process.pid,
      ...value,
    }) + "\n",
  );
}

function responsePath(route) {
  return join(
    process.env.NPM_CLI_RESPONSES_DIR,
    createHash("sha256").update(route).digest("hex") + ".json",
  );
}

function readResponse(route) {
  try {
    return JSON.parse(readFileSync(responsePath(route), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function response(route, transport) {
  record({
    kind: "request",
    transport,
    route,
    callsite: process.env.NPM_CLI_CALLSITE ?? callsite(),
  });
  const [path, query] = route.split("?");
  const params = new URLSearchParams(query);
  params.sort();
  const key = query ? path + "?" + params.toString() : route;
  const value = readResponse(key);
  if (!value) {
    throw new Error("Unconfigured external fixture request: " + route);
  }
  if (value.after) {
    const after = value.after;
    delete value.after;
    writeFileSync(responsePath(after.route), JSON.stringify(after.value));
    if (after.route !== key) {
      writeFileSync(responsePath(key), JSON.stringify(value));
    }
    record({ kind: "external-change", route });
  }
  if (value.status >= 400) {
    throw new Error("gh: Server Error (HTTP " + value.status + ")");
  }
  if (/^actions\/runs\/[0-9]+\/artifacts$/u.test(path)) {
    const page = JSON.parse(value.data);
    page.artifacts = page.artifacts.map((artifact) => {
      const current = readResponse("actions/artifacts/" + artifact.id);
      return current ? JSON.parse(current.data) : artifact;
    });
    return Buffer.from(JSON.stringify(page));
  }
  return Buffer.from(value.data, value.encoding);
}

export function runGh(args) {
  if (args[0] !== "api" && !(args[0] === "run" && args[1] === "view")) {
    throw new Error("Unexpected non-read GitHub fixture command");
  }
  const method = args.indexOf("--method");
  if (method >= 0 && args[method + 1] !== "GET") {
    throw new Error("Unexpected GitHub mutation");
  }
  const route =
    args[0] === "run"
      ? "run view " + args[2]
      : args[1]?.replace(/^repos\/openclaw\/openclaw\//u, "");
  process.stdout.write(response(route, "gh"));
}

if (process.env.NPM_CLI_ENTRYPOINT && import.meta.url !== pathToFileURL(process.argv[1]).href) {
  if (process.argv[1] === process.env.NPM_CLI_ENTRYPOINT) {
    record({ kind: "entrypoint" });
    // Exercise production retry accounting without sleeping through its backoff.
    Atomics.wait = () => {
      record({ kind: "retry-wait" });
      return "timed-out";
    };
    for (const method of ["execFileSync", "spawn"]) {
      const original = childProcess[method];
      childProcess[method] = (file, args, options) =>
        original(file, args, {
          ...options,
          env: { ...(options?.env ?? process.env), NPM_CLI_CALLSITE: callsite() },
        });
    }
    syncBuiltinESMExports();
  }
  globalThis.fetch = async (input, init) => {
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method.toUpperCase() !== "GET") {
      throw new Error("Unexpected GitHub mutation");
    }
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== "https://api.github.com") {
      throw new Error("Unexpected external fixture host: " + url.origin);
    }
    return new Response(
      Uint8Array.from(
        response(url.pathname.replace(/^\/repos\/openclaw\/openclaw\//u, "") + url.search, "fetch"),
      ),
    );
  };
}
