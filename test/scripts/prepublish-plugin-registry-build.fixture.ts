import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function writeCombinedBuildFixture(repoRoot: string, names: string[], version: string) {
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
  for (const entry of ["tsx.mjs", "lib/plugin-npm-build-and-pack.mts"]) {
    writeFileSync(
      path.join(repoRoot, "scripts", entry),
      `import ${JSON.stringify(pathToFileURL(path.resolve("scripts", entry)).href)};\n`,
    );
  }
}
