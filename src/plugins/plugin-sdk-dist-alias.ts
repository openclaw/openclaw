import fs from "node:fs";
import path from "node:path";
import { writeJsonSync } from "../infra/json-files.js";

function writeRuntimeJsonFile(targetPath: string, value: unknown): void {
  writeJsonSync(targetPath, value);
}

function writeRuntimeModuleWrapper(sourcePath: string, targetPath: string): void {
  const relative = `./${path.relative(path.dirname(targetPath), sourcePath).split(path.sep).join("/")}`;
  const content = [`export * from ${JSON.stringify(relative)};`, ""].join("\n");
  try {
    if (fs.readFileSync(targetPath, "utf8") === content) {
      return;
    }
  } catch {
    // Missing or unreadable wrapper; rewrite below.
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, "utf8");
}

function ensureOpenClawOcPathAlias(distRoot: string): void {
  const ocPathDir = path.join(distRoot, "extensions", "oc-path");
  const ocPathApiPath = path.join(ocPathDir, "api.js");
  if (!fs.existsSync(ocPathApiPath)) {
    return;
  }

  const aliasDir = path.join(distRoot, "extensions", "node_modules", "@openclaw", "oc-path");
  writeRuntimeJsonFile(path.join(aliasDir, "package.json"), {
    name: "@openclaw/oc-path",
    type: "module",
    exports: {
      ".": "./index.js",
      "./api.js": "./api.js",
    },
  });
  writeRuntimeModuleWrapper(path.join(ocPathDir, "index.js"), path.join(aliasDir, "index.js"));
  writeRuntimeModuleWrapper(ocPathApiPath, path.join(aliasDir, "api.js"));
}

export function ensureOpenClawPluginSdkAlias(distRoot: string): void {
  const pluginSdkDir = path.join(distRoot, "plugin-sdk");
  if (!fs.existsSync(pluginSdkDir)) {
    ensureOpenClawOcPathAlias(distRoot);
    return;
  }

  const aliasDir = path.join(distRoot, "extensions", "node_modules", "openclaw");
  const pluginSdkAliasDir = path.join(aliasDir, "plugin-sdk");
  writeRuntimeJsonFile(path.join(aliasDir, "package.json"), {
    name: "openclaw",
    type: "module",
    exports: {
      "./plugin-sdk": "./plugin-sdk/index.js",
      "./plugin-sdk/*": "./plugin-sdk/*.js",
    },
  });
  try {
    if (fs.existsSync(pluginSdkAliasDir) && !fs.lstatSync(pluginSdkAliasDir).isDirectory()) {
      fs.rmSync(pluginSdkAliasDir, { recursive: true, force: true });
    }
  } catch {
    // Another process may be creating the alias at the same time.
  }
  fs.mkdirSync(pluginSdkAliasDir, { recursive: true });
  for (const entry of fs.readdirSync(pluginSdkDir, { withFileTypes: true })) {
    if (!entry.isFile() || path.extname(entry.name) !== ".js") {
      continue;
    }
    writeRuntimeModuleWrapper(
      path.join(pluginSdkDir, entry.name),
      path.join(pluginSdkAliasDir, entry.name),
    );
  }
  ensureOpenClawOcPathAlias(distRoot);
}
