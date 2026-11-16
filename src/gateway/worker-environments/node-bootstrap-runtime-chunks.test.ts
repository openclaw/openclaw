import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveNodeBootstrapRuntimeChunks } from "./node-bootstrap-runtime-chunks.js";

const directories = useAutoCleanupTempDirTracker(afterEach);

it("selects CommonJS chunks from the package inventory without consulting unlisted manifests", async () => {
  const root = directories.make("openclaw-runtime-chunks-");
  const sources: Record<string, string> = {
    "dist/entry.mjs": `const load = () => {};
load("./used"); load("./directory"); load("./main"); load("./unlisted");
String("."); String(".sqlite");`,
    "dist/used.js": "export const used = true;",
    "dist/directory/index.js": "export const directory = true;",
    "dist/main/package.json": '{"main":"./entry"}',
    "dist/main/entry.js": "export const main = true;",
    "dist/hidden.mjs": "export const hidden = true;",
  };
  const privateFiles = [
    "dist/used.js",
    "dist/directory/index.js",
    "dist/main/entry.js",
    "dist/hidden.mjs",
  ];
  const write = (file: string, contents: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), contents);
  };
  for (const [file, contents] of Object.entries(sources)) {
    write(file, contents);
  }
  // An unrelated on-disk manifest must not change the declared package graph.
  write("dist/unlisted/package.json", '{"main":"../hidden.mjs"}');
  write(
    "dist/runtime-dependency-ownership.json",
    JSON.stringify({
      chunks: Object.fromEntries(
        privateFiles.map((file) => [
          file.slice("dist/".length),
          {
            sha256: createHash("sha256").update(sources[file]!).digest("hex"),
            extensions: ["omitted"],
          },
        ]),
      ),
    }),
  );

  const result = await resolveNodeBootstrapRuntimeChunks(
    root,
    Object.keys(sources),
    [],
    new Set(["omitted"]),
  );
  expect(result.files).toEqual([
    "dist/entry.mjs",
    "dist/used.js",
    "dist/directory/index.js",
    "dist/main/package.json",
    "dist/main/entry.js",
  ]);
});
