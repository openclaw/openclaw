import fs from "node:fs";
import path from "node:path";
import type { PluginKind } from "../plugins/types.js";
import { PLUGIN_MANIFEST_FILENAME } from "../plugins/manifest.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import { resolveUserPath } from "../utils.js";

export type PluginInitOptions = {
  id?: string;
  name?: string;
  description?: string;
  kind?: string;
  force?: boolean;
};

const VALID_KINDS: readonly PluginKind[] = ["memory", "context-engine"];

function validatePluginId(id: string): string | null {
  if (!id) {
    return "invalid plugin name: missing";
  }
  if (id === "." || id === "..") {
    return "invalid plugin name: reserved path segment";
  }
  if (id.includes("/") || id.includes("\\")) {
    return "invalid plugin name: path separators not allowed";
  }
  return null;
}

const INDEX_TS = `import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

export default function register(api: OpenClawPluginApi) {
  //
}
`;

export function runPluginInit(dir: string | undefined, opts: PluginInitOptions) {
  const targetDir = resolveUserPath(dir || ".");
  const id = opts.id || (() => {
    const base = path.basename(path.resolve(targetDir));
    return base && base !== "." && base !== ".." && base !== "/" ? base : null;
  })();

  if (!id) {
    defaultRuntime.error("cannot derive plugin name from directory — use --id");
    defaultRuntime.exit(1);
    return;
  }

  const idError = validatePluginId(id);
  if (idError) {
    defaultRuntime.error(idError);
    defaultRuntime.exit(1);
    return;
  }

  if (opts.kind && !VALID_KINDS.includes(opts.kind as PluginKind)) {
    defaultRuntime.error(`invalid kind: ${opts.kind}`);
    defaultRuntime.exit(1);
    return;
  }

  fs.mkdirSync(targetDir, { recursive: true });

  const force = Boolean(opts.force);
  const manifest: Record<string, unknown> = { id };
  if (opts.name) manifest.name = opts.name;
  if (opts.description) manifest.description = opts.description;
  if (opts.kind) manifest.kind = opts.kind;
  manifest.configSchema = {
    type: "object",
    additionalProperties: false,
    properties: {},
  };

  const pkg = {
    name: id,
    version: "0.0.1",
    type: "module",
    openclaw: { extensions: ["./index.ts"] },
  };

  const files: [string, string][] = [
    [path.join(targetDir, PLUGIN_MANIFEST_FILENAME), JSON.stringify(manifest, null, 2) + "\n"],
    [path.join(targetDir, "index.ts"), INDEX_TS],
    [path.join(targetDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n"],
  ];

  for (const [filePath, content] of files) {
    if (fs.existsSync(filePath) && !force) {
      defaultRuntime.error(`${path.basename(filePath)} already exists (use --force to overwrite)`);
      defaultRuntime.exit(1);
      return;
    }
    fs.writeFileSync(filePath, content, "utf-8");
  }

  defaultRuntime.log(`Created plugin ${theme.command(id)} in ${targetDir}`);
  defaultRuntime.log(
    theme.muted(`Install with: openclaw plugins install ${targetDir === process.cwd() ? "." : targetDir}`),
  );
}
