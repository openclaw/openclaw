import { spawnSync } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import * as tar from "tar";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.runIf(process.platform !== "win32")(
  "builds more workspace files than the descriptor limit",
  async () => {
    const directory = tempDirs.make("openclaw-template-descriptors-");
    const project = join(directory, "project");
    await mkdir(project);
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({
        name: "many-files",
        version: "1.0.0",
        openclaw: { template: "CLAW.md" },
      }),
    );
    const files: Array<{ source: string; path: string }> = [];
    for (let index = 0; index < 160; index += 1) {
      const source = `reference-${index}.md`;
      await writeFile(join(project, source), `Reference ${index}\n`);
      files.push({ source, path: source });
    }
    const manifest = (count: number) =>
      `---\n${JSON.stringify({
        schemaVersion: 1,
        agent: { id: "reader-agent" },
        workspace: { files: files.slice(0, count) },
      })}\n---\n`;
    const manifestPath = join(project, "CLAW.md");
    await writeFile(manifestPath, manifest(16));
    const output = join(directory, "many.tgz");
    await symlink(join(process.cwd(), "node_modules"), join(directory, "node_modules"), "dir");
    const modulePath = join(directory, "project-build.mjs");
    await build({
      entryPoints: [fileURLToPath(new URL("./project-build.ts", import.meta.url))],
      absWorkingDir: process.cwd(),
      bundle: true,
      format: "esm",
      outfile: modulePath,
      packages: "external",
      platform: "node",
    });
    const script = [
      `const { buildTemplateProject } = await import(${JSON.stringify(modulePath)});`,
      'const { writeFile } = await import("node:fs/promises");',
      `await buildTemplateProject(${JSON.stringify(project)}, ${JSON.stringify(join(directory, "control.tgz"))});`,
      'console.log("control built");',
      `await writeFile(${JSON.stringify(manifestPath)}, ${JSON.stringify(manifest(160))});`,
      `await buildTemplateProject(${JSON.stringify(project)}, ${JSON.stringify(output)});`,
    ].join("\n");
    const result = spawnSync(
      "/bin/sh",
      [
        "-c",
        'ulimit -n 128 || exit; exec "$@"',
        "template-reader",
        process.execPath,
        "--input-type=module",
        "--eval",
        script,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_OPTIONS: undefined,
          VITEST: undefined,
          VITEST_POOL_ID: undefined,
          VITEST_WORKER_ID: undefined,
        },
        timeout: 30_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.stdout).toContain("control built");
    expect(result.status, result.stderr).toBe(0);
    const entries: string[] = [];
    await tar.t({ file: output, onentry: (entry) => entries.push(entry.path) });
    expect(entries).toHaveLength(162);
  },
  120_000,
);
