import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generator = "scripts/generate-control-ui-validators.mts";
const node = resolveTestNodeExecPath();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("generates identical standalone validators across physical pnpm layouts without hiding schema drift", async () => {
  // Only TypeBox must be physically relocated. Other pinned tools retain their installed owners.
  const scratch = tempDirs.make("validator-layouts-");
  const closure = await build({
    absWorkingDir: repoRoot,
    entryPoints: [generator],
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    write: false,
    metafile: true,
  });
  const typebox = path.resolve(fileURLToPath(import.meta.resolve("typebox")), "../..");
  const outputs: Array<Record<string, string>> = [];
  for (const layout of ["hoisted", "isolated", "global-store"]) {
    const root = path.join(scratch, layout);
    for (const input of Object.keys(closure.metafile!.inputs)) {
      const destination = path.join(root, input);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(repoRoot, input), destination);
    }
    // Compiler optimizations must preserve code-looking data in canonical schemas.
    const reactions = path.join(root, "packages/gateway-protocol/src/schema/sessions-reactions.ts");
    fs.writeFileSync(
      reactions,
      fs
        .readFileSync(reactions, "utf8")
        .replace('["added", "removed"]', '[".map(Hashing.Hash)", "removed"]'),
    );
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
    const modules = path.join(root, "node_modules");
    fs.mkdirSync(modules);
    const physical =
      layout === "hoisted"
        ? path.join(modules, "typebox")
        : layout === "isolated"
          ? path.join(modules, ".pnpm/typebox@1.3.36/node_modules/typebox")
          : path.join(scratch, "store/links/typebox/1.3.36/graph/node_modules/typebox");
    fs.cpSync(typebox, physical, { recursive: true });
    if (layout !== "hoisted") {
      fs.symlinkSync(physical, path.join(modules, "typebox"), "dir");
    }
    for (const name of ["acorn", "esbuild", "oxfmt"]) {
      fs.symlinkSync(
        fs.realpathSync(path.join(repoRoot, "node_modules", name)),
        path.join(modules, name),
        "dir",
      );
    }
    const run = (...args: string[]) =>
      spawnSync(
        node,
        ["--import", path.join(repoRoot, "scripts/tsx.mjs"), path.join(root, generator), ...args],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, TSX_TSCONFIG_PATH: path.join(repoRoot, "tsconfig.json") },
        },
      );
    const generated = run();
    expect(generated.status, generated.stdout + generated.stderr).toBe(0);
    const files = generated.stdout
      .trim()
      .split("\n")
      .map((line) => line.split(" ").at(-1)!);
    const output = Object.fromEntries(
      files.map((file) => [file, fs.readFileSync(path.join(root, file), "utf8")]),
    );
    expect(output["ui/src/lib/protocol-validators.generated/activity.js"]).toContain(
      ".map(Hashing.Hash)",
    );
    outputs.push(output);
    expect(run("--check").status).toBe(0);
    // Freshness must notice an actual public schema constraint change, not merely edited output.
    if (layout === "hoisted") {
      const source = fs.readFileSync(reactions, "utf8");
      expect(source).toContain("maxLength: 32");
      fs.writeFileSync(reactions, source.replace("maxLength: 32", "maxLength: 31"));
      const stale = run("--check");
      expect(stale.status).toBe(1);
      expect(stale.stderr).toContain("activity.js is stale");
      expect(fs.readFileSync(path.join(root, files[0]!), "utf8")).toBe(output[files[0]!]);
    }
  }
  expect(outputs[1]).toEqual(outputs[0]);
  expect(outputs[2]).toEqual(outputs[0]);
});
