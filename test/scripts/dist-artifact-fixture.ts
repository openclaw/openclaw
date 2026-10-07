import fs from "node:fs";
import path from "node:path";
import { materializeNativeCompiler } from "./native-boundary-fixture.js";

function write(root: string, relative: string, content: string) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

export function installDistArtifactScripts(
  root: string,
  scripts: string[],
  { compiler = true, dependencies = ["tsx", "@openclaw/fs-safe"] } = {},
) {
  const sourceRoot = process.cwd();
  // Keep the checkpoint launcher when installCompiler already owns this toolchain.
  if (compiler && !fs.existsSync(path.join(root, "node_modules/typescript/package.json"))) {
    materializeNativeCompiler(root);
  }
  for (const script of ["tsx.mjs", "generate-kysely-types.mts", ...scripts]) {
    write(
      root,
      `scripts/${script}`,
      fs.readFileSync(path.join(sourceRoot, "scripts", script), "utf8"),
    );
  }
  for (const file of [
    "scripts/lib",
    "scripts/windows-cmd-helpers.mjs",
    "packages/normalization-core/src",
    "packages/normalization-core/package.json",
    "src/infra/node-compiler-policy.mjs",
    "src/infra/node-compiler-policy.d.mts",
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.cpSync(path.join(sourceRoot, file), path.join(root, file), { recursive: true });
  }
  write(root, "scripts/lib/plugin-sdk-entrypoints.json", '["qa-channel-protocol"]');
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  for (const name of dependencies) {
    fs.mkdirSync(path.dirname(path.join(root, "node_modules", name)), { recursive: true });
    fs.symlinkSync(
      path.join(sourceRoot, "node_modules", name),
      path.join(root, "node_modules", name),
      process.platform === "win32" ? "junction" : "dir",
    );
  }
}
