import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";
import e2eConfig from "./vitest.e2e.config.ts";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for the selected Crabline candidate`);
  }
  return value;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const root = realpathSync(required("CRABLINE_CANDIDATE_ROOT"));
const files: string[] = [];
function inventory(directory: string): void {
  for (const name of readdirSync(directory).toSorted()) {
    const file = path.join(directory, name);
    const stat = lstatSync(file);
    if (stat.isDirectory()) {
      inventory(file);
    } else if (stat.isFile()) {
      const bytes = readFileSync(file);
      files.push(
        `${path.relative(root, file).split(path.sep).join("/")}\0${sha256(bytes)}\0${bytes.length}\n`,
      );
    } else {
      throw new Error("Candidate package contains a non-regular entry");
    }
  }
}
inventory(root);
if (sha256(files.toSorted().join("")) !== required("CRABLINE_CANDIDATE_PACKAGE_SHA256")) {
  throw new Error("Crabline installed package byte identity differs from the verified archive");
}
if (
  sha256(readFileSync(required("CRABLINE_CANDIDATE_ARCHIVE"))) !==
  required("CRABLINE_CANDIDATE_ARCHIVE_SHA256")
) {
  throw new Error("Crabline candidate archive identity mismatch");
}
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  name?: string;
  exports?: { "."?: { import?: string; types?: string } };
};
if (pkg.name !== "@openclaw/crabline") {
  throw new Error("Wrong candidate package");
}
const entry = pkg.exports?.["."]?.import;
const types = pkg.exports?.["."]?.types;
if (!entry || !types) {
  throw new Error("Candidate root runtime and type exports are required");
}
for (const exported of [entry, types]) {
  const resolved = realpathSync(path.resolve(root, exported));
  if (!resolved.startsWith(`${root}${path.sep}`) || !lstatSync(resolved).isFile()) {
    throw new Error("Candidate root export escapes the verified package");
  }
}
const inheritedAliases = e2eConfig.resolve?.alias;
const aliases = Array.isArray(inheritedAliases)
  ? inheritedAliases
  : Object.entries(inheritedAliases ?? {}).map(([find, replacement]) => ({ find, replacement }));

export default defineConfig({
  ...e2eConfig,
  resolve: {
    ...e2eConfig.resolve,
    alias: [{ find: /^@openclaw\/crabline$/u, replacement: path.resolve(root, entry) }, ...aliases],
  },
  test: {
    ...e2eConfig.test,
    include: ["test/e2e/qa-lab/plugins/feishu-crabline.real-gateway.candidate.e2e.test.mts"],
    fileParallelism: false,
    maxWorkers: 1,
  },
});
