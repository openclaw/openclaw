import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as tar from "tar";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { templateProjectBuildEntrypoint } from "./project-runtime.test-support.js";

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
    const moduleUrl = resolveRuntimeWorkerUrl(templateProjectBuildEntrypoint);
    const script = [
      `const { buildTemplateProject } = await import(${JSON.stringify(moduleUrl.href)});`,
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
        ...resolveRuntimeWorkerArgv(moduleUrl).slice(0, -1),
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
);
