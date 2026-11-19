import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";

// Only the worker-local --import operand carries the owning capture's SDK aliases.
const entry = new URL("./plugin-sdk-worker-preload.js", import.meta.url);
const operand = process.execArgv.find((value, index, args) =>
  args[index - 1] === "--import" && value.startsWith(entry.href + "?"),
);
if (!isMainThread && operand) {
  const params = new URL(operand).searchParams;
  const root = params.get("root");
  const aliases = new Map<string, string>(JSON.parse(params.get("aliases") ?? "[]"));
  const host = fs.realpathSync.native(fileURLToPath(new URL("../", entry)));
  const hostPrefix = pathToFileURL(host + path.sep).href;
  function physicalUrl(file: string): URL | undefined {
    try {
      return pathToFileURL(fs.realpathSync.native(file));
    } catch {
      return undefined;
    }
  }
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const name = specifier.endsWith(".js") ? specifier.slice(0, -3) : specifier;
      const relative = aliases.get(name);
      if (root && relative && context.parentURL?.startsWith("file:")) {
        const parent = physicalUrl(fileURLToPath(context.parentURL));
        if (parent?.href.startsWith(root)) {
          const target = physicalUrl(path.resolve(host, relative));
          if (target?.href.startsWith(hostPrefix)) {
            const request = context.conditions.includes("require")
              ? fileURLToPath(target)
              : target.href;
            return nextResolve(request, context);
          }
        }
      }
      return nextResolve(specifier, context);
    },
  });
}
