import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function writeCombinedBuildFixture(
  repoRoot: string,
  names: string[],
  version: string,
  batch = false,
) {
  for (const name of names) {
    const packageDir = path.join(repoRoot, "extensions", name.split("/")[1]!);
    writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name,
        version,
        type: "module",
        openclaw: { extensions: ["./index.ts"], release: { publishToNpm: true } },
      }),
    );
    writeFileSync(
      path.join(packageDir, "index.ts"),
      'export const message: string = "built before packing";\n',
    );
    writeFileSync(
      path.join(packageDir, "openclaw.plugin.json"),
      JSON.stringify({ id: name.split("/")[1], configSchema: { type: "object", properties: {} } }),
    );
  }
  const entries = ["tsx.mjs", "lib/plugin-npm-build-and-pack.mts"];
  if (batch) {
    entries.push("lib/plugin-npm-build-and-pack-batch.mts");
  }
  for (const entry of entries) {
    writeFileSync(
      path.join(repoRoot, "scripts", entry),
      `import ${JSON.stringify(pathToFileURL(path.resolve("scripts", entry)).href)};\n` +
        (batch && entry === "tsx.mjs"
          ? 'import { appendFileSync } from "node:fs"; appendFileSync(".build-processes", `${process.pid}\\n`);\n'
          : ""),
    );
  }
}
