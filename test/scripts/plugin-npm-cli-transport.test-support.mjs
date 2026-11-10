// Raw external-I/O fixture shared by the real CLI and its gh subprocesses.
// No release owner is replaced: all authentication and archive checks run in CLI.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

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

function response(route, transport) {
  record({ kind: "request", transport, route });
  const responses = JSON.parse(readFileSync(process.env.NPM_CLI_RESPONSES, "utf8"));
  const [path, query] = route.split("?");
  const params = new URLSearchParams(query);
  params.sort();
  const value = responses[query ? path + "?" + params.toString() : route];
  if (!value) throw new Error("Unconfigured external fixture request: " + route);
  if (value.after) {
    responses[value.after.route] = value.after.value;
    delete value.after;
    writeFileSync(process.env.NPM_CLI_RESPONSES, JSON.stringify(responses));
    record({ kind: "external-change", route });
  }
  return Buffer.from(value.data, value.encoding);
}

export function runGh(args) {
  if (args[0] !== "api" && !(args[0] === "run" && args[1] === "view")) {
    throw new Error("Unexpected non-read GitHub fixture command");
  }
  const method = args.indexOf("--method");
  if (method >= 0 && args[method + 1] !== "GET") throw new Error("Unexpected GitHub mutation");
  const route =
    args[0] === "run"
      ? "run view " + args[2]
      : args[1]?.replace(/^repos\/openclaw\/openclaw\//u, "");
  process.stdout.write(response(route, "gh"));
}

if (process.env.NPM_CLI_ENTRYPOINT && import.meta.url !== pathToFileURL(process.argv[1]).href) {
  if (process.argv[1] === process.env.NPM_CLI_ENTRYPOINT) {
    record({ kind: "entrypoint" });
  }
  globalThis.fetch = async (input, init) => {
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method.toUpperCase() !== "GET") throw new Error("Unexpected GitHub mutation");
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
