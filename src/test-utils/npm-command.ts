import { createRequire } from "node:module";
import path from "node:path";

const npmCliPath = path.join(
  path.dirname(createRequire(import.meta.url).resolve("npm/package.json")),
  "bin",
  "npm-cli.js",
);

export function expectedNpmCommand(args: readonly string[]): string[] {
  return process.versions.bun ? [process.execPath, npmCliPath, ...args] : ["npm", ...args];
}

export function npmCommandArgs(argv: readonly string[]): string[] | undefined {
  const prefix = expectedNpmCommand([]);
  return prefix.every((part, index) => argv[index] === part)
    ? argv.slice(prefix.length)
    : undefined;
}
