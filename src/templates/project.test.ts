import { spawnSync } from "node:child_process";
import fs, { lstat, mkdir, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import * as tar from "tar";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { withEnvAsync } from "../test-utils/env.js";
import { buildTemplateProject } from "./project-build.js";
import { templateProjectBuildEntrypoint } from "./project-runtime.test-support.js";
import { TemplateProjectError, createTemplateProject, validateTemplateProject } from "./project.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const GOLDEN_ARTIFACT_INTEGRITY =
  "sha256:4417f904720e4ea9f98246a64530691373f051c1b5fe47cb1d33009a21852915";
const goldenProject = join(process.cwd(), "test", "fixtures", "templates", "project-v1");

async function replaceManifest(root: string, from: string, to: string) {
  const path = join(root, "CLAW.md");
  await writeFile(path, (await readFile(path, "utf8")).replace(from, to));
}

async function archiveEntries(file: string) {
  const entries: string[] = [];
  await tar.t({ file, onentry: (entry) => entries.push(entry.path) });
  return entries;
}

async function expectInvalidProject(root: string, code: string) {
  await expect(validateTemplateProject(root)).resolves.toMatchObject({
    ok: false,
    diagnostics: [expect.objectContaining({ code })],
  });
}

async function writePackage(root: string, fields: Record<string, unknown> = {}) {
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({
      name: "demo-template",
      version: "1.2.3",
      openclaw: { template: "CLAW.md" },
      ...fields,
    })}\n`,
  );
}

async function relocateProfile(root: string, filename: string) {
  await rename(join(root, "profiles", "openclaw.yml"), join(root, "profiles", filename));
  await replaceManifest(
    root,
    "agent:\n  id: demo-template",
    `agent:\n  id: demo-template\nmetadata:\n  openclaw.config: profiles/${filename}`,
  );
}

async function writeRichProject(root: string): Promise<void> {
  await mkdir(join(root, "workspace"), { recursive: true });
  await mkdir(join(root, "profiles"), { recursive: true });
  await writePackage(root);
  await writeFile(
    join(root, "CLAW.md"),
    "---\nschemaVersion: 1\nagent:\n  id: demo-template\nworkspace:\n  files:\n    - source: workspace/reference.md\n      path: reference.md\n---\nYou are the demo Template.\n",
  );
  await writeFile(join(root, "workspace", "reference.md"), "# Reference\n");
  await writeFile(join(root, "BOOTSTRAP.md"), "Interview the user before starting.\n");
  await writeFile(join(root, "profiles", "openclaw.yml"), "schemaVersion: 1\nagent: {}\n");
  await writeFile(join(root, "not-packed.txt"), "local scratch\n");
}

describe("Template projects", () => {
  it("matches the cross-platform golden artifact digest", async () => {
    const output = join(tempDirs.make("openclaw-template-golden-"), "golden.tgz");
    const result = await buildTemplateProject(goldenProject, output);

    expect(result.integrity).toBe(GOLDEN_ARTIFACT_INTEGRITY);
  });

  it("matches the golden artifact digest under a restrictive umask", () => {
    const output = join(tempDirs.make("openclaw-template-umask-"), "golden.tgz");
    const projectBuildUrl = resolveRuntimeWorkerUrl(templateProjectBuildEntrypoint);
    const script = [
      "process.umask(0o077);",
      `const { buildTemplateProject } = await import(${JSON.stringify(projectBuildUrl.href)});`,
      `const result = await buildTemplateProject(${JSON.stringify(goldenProject)}, ${JSON.stringify(output)});`,
      "process.stdout.write(result.integrity);",
    ].join("\n");

    const result = spawnSync(
      process.execPath,
      [
        ...resolveRuntimeWorkerArgv(projectBuildUrl).slice(0, -1),
        "--input-type=module",
        "--eval",
        script,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_DISABLE_COMPILE_CACHE: "1",
          NODE_OPTIONS: undefined,
          VITEST: undefined,
          VITEST_POOL_ID: undefined,
          VITEST_WORKER_ID: undefined,
        },
        timeout: 60_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(GOLDEN_ARTIFACT_INTEGRITY);
  });

  it("refuses to publish and removes staging when a completed file fails to close", async () => {
    const outputDirectory = tempDirs.make("openclaw-template-close-failure-");
    const output = join(outputDirectory, "template.tgz");
    const closeError = Object.assign(new Error("staged file close failed"), { code: "EIO" });
    const open = fs.open;
    let closeAttempts = 0;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (
        String(args[0]).startsWith(`${outputDirectory}${sep}`) &&
        (await handle.stat()).isFile()
      ) {
        const close = handle.close.bind(handle);
        vi.spyOn(handle, "close").mockImplementation(async () => {
          await close();
          closeAttempts += 1;
          throw closeError;
        });
      }
      return handle;
    });
    try {
      await withEnvAsync({ FS_SAFE_NATIVE_MODE: "off" }, async () => {
        await expect(buildTemplateProject(goldenProject, output)).rejects.toBe(closeError);
      });
      expect(closeAttempts).toBe(1);
      await expect(readdir(outputDirectory)).resolves.toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("creates a minimal project that validates through the canonical reader", async () => {
    const root = join(tempDirs.make("openclaw-template-create-"), "research-assistant");

    const created = await createTemplateProject(root);
    const validated = await validateTemplateProject(root);

    expect(created.packageJson).toEqual({
      name: "research-assistant",
      version: "0.1.0",
      openclaw: { template: "CLAW.md" },
    });
    assert(validated.ok);
    expect(validated.template.manifest.agent.id).toBe("research-assistant");
    expect(validated.template.templateMarkdownBody?.toString()).toContain(
      "purpose-built OpenClaw agent",
    );
  });

  it("keeps one concurrent creator's completed project", async () => {
    const root = join(tempDirs.make("openclaw-template-create-race-"), "shared");
    await mkdir(root);

    const results = await Promise.allSettled([
      createTemplateProject(root),
      createTemplateProject(root),
    ]);

    expect(results.map((result) => result.status).toSorted()).toEqual(["fulfilled", "rejected"]);
    await expect(validateTemplateProject(root)).resolves.toMatchObject({ ok: true });
  });
});

describe("Template project packages", () => {
  let project: string;
  let output: string;
  beforeEach(async () => {
    const root = tempDirs.make("openclaw-template-project-");
    project = join(root, "project");
    output = join(root, "template.tgz");
    await writeRichProject(project);
  });

  it("refuses occupied targets and package lifecycle scripts", async () => {
    const occupied = tempDirs.make("openclaw-template-occupied-");
    await writeFile(join(occupied, "keep.txt"), "keep\n");
    await expect(createTemplateProject(occupied)).rejects.toMatchObject({
      code: "project_target_not_empty",
    } satisfies Partial<TemplateProjectError>);

    await writePackage(project, { scripts: { postinstall: "echo unsafe" } });
    const result = await validateTemplateProject(project);
    assert(!result.ok);
    expect(result.diagnostics.map((item) => item.code)).toContain("project_scripts_forbidden");
  });

  it("rejects package.json as a managed workspace source", async () => {
    await replaceManifest(
      project,
      "    - source: workspace/reference.md\n      path: reference.md",
      "    - source: package.json\n      path: metadata.json",
    );
    await expectInvalidProject(project, "project_invalid");
    await expect(buildTemplateProject(project, output)).rejects.toMatchObject({
      code: "project_invalid",
    } satisfies Partial<TemplateProjectError>);
  });

  it("builds byte-identical artifacts containing only declared project inputs", async () => {
    const firstPath = output;
    const secondPath = join(dirname(output), "second.tgz");

    const first = await buildTemplateProject(project, firstPath);
    const second = await buildTemplateProject(project, secondPath);
    const validation = await validateTemplateProject(join(project, "workspace", "reference.md"));
    const entries = await archiveEntries(firstPath);

    expect(await readFile(firstPath)).toEqual(await readFile(secondPath));
    expect(first.integrity).toBe(second.integrity);
    expect(first.excludedPaths).toEqual(["not-packed.txt"]);
    expect(validation).toMatchObject({ ok: true, excludedPaths: ["not-packed.txt"] });
    expect(entries).toEqual([
      "package/BOOTSTRAP.md",
      "package/CLAW.md",
      "package/package.json",
      "package/profiles/openclaw.yml",
      "package/workspace/reference.md",
    ]);
  });

  it("preserves license metadata and a package-root LICENSE in the artifact", async () => {
    const unpacked = tempDirs.make("openclaw-template-license-unpacked-");
    await writePackage(project, { license: "MIT" });
    await writeFile(join(project, "LICENSE"), "License notice for the demo Template.\n");

    const validated = await validateTemplateProject(project);
    const result = await buildTemplateProject(project, output);
    await tar.x({ cwd: unpacked, file: output, strict: true });

    assert(validated.ok);
    expect(validated.excludedPaths).not.toContain("LICENSE");
    expect(result.files).toContain("LICENSE");
    expect(
      JSON.parse(await readFile(join(unpacked, "package", "package.json"), "utf8")),
    ).toMatchObject({ license: "MIT" });
    expect(await readFile(join(unpacked, "package", "LICENSE"), "utf8")).toBe(
      "License notice for the demo Template.\n",
    );
  });

  it("rejects an unsafe package-root LICENSE", async () => {
    const outside = tempDirs.make("openclaw-template-license-outside-");
    await writeFile(join(outside, "LICENSE"), "Outside notice.\n");
    await symlink(join(outside, "LICENSE"), join(project, "LICENSE"), "file");

    await expectInvalidProject(project, "project_license_invalid");
  });

  it("preserves the canonical metadata-selected OpenClaw profile path", async () => {
    await relocateProfile(project, "custom.yaml");

    const validation = await validateTemplateProject(project);
    const result = await buildTemplateProject(project, output);
    const entries = await archiveEntries(output);

    assert(validation.ok);
    expect(validation.template.snapshot.openClawProfile?.sourcePath).toBe("profiles/custom.yaml");
    expect(validation.excludedPaths).not.toContain("profiles/custom.yaml");
    expect(result.files).toContain("profiles/custom.yaml");
    expect(entries).toContain("package/profiles/custom.yaml");
    expect(entries).not.toContain("package/profiles/openclaw.yml");
  });

  it.each(["@notes.md", "..notes.md"])(
    "packages %s as an ordinary workspace source",
    async (name) => {
      await replaceManifest(project, "workspace/reference.md", JSON.stringify(name));
      await writeFile(join(project, name), "# Notes\n");

      const result = await buildTemplateProject(project, output);
      const entries = await archiveEntries(output);

      expect(result.files).toContain(name);
      expect(entries).toContain(`package/${name}`);
    },
  );

  it("normalizes accepted backslash source separators in the built package", async () => {
    await replaceManifest(
      project,
      "    - source: workspace/reference.md",
      String.raw`    - source: 'workspace\reference.md'`,
    );

    const validation = await validateTemplateProject(project);
    const result = await buildTemplateProject(project, output);
    const entries = await archiveEntries(output);

    expect(validation).toMatchObject({ ok: true });
    expect(result.files).toContain("workspace/reference.md");
    expect(entries).toContain("package/workspace/reference.md");
  });

  it("preserves long workspace source paths deterministically", async () => {
    const longName = `${"a".repeat(140)}.md`;
    const longSource = `workspace/${longName}`;
    await replaceManifest(project, "workspace/reference.md", longSource);
    await writeFile(join(project, longSource), "# Long path\n");

    const firstPath = output;
    const secondPath = join(dirname(output), "second.tgz");
    const first = await buildTemplateProject(project, firstPath);
    const second = await buildTemplateProject(project, secondPath);
    const entries = await archiveEntries(firstPath);

    expect(await readFile(firstPath)).toEqual(await readFile(secondPath));
    expect(first.integrity).toBe(second.integrity);
    expect(first.files).toContain(longSource);
    expect(entries).toContain(`package/${longSource}`);
  });

  it.runIf(process.platform === "win32")(
    "does not report a differently cased selected file as excluded",
    async () => {
      const temporaryManifest = join(project, "manifest.tmp");
      await rename(join(project, "CLAW.md"), temporaryManifest);
      await rename(temporaryManifest, join(project, "claw.md"));

      const result = await validateTemplateProject(project);

      assert(result.ok);
      expect(result.excludedPaths).not.toContain("claw.md");
    },
  );

  it("dereferences only a confined CLAW.md symlink into the artifact", async () => {
    const unpacked = tempDirs.make("openclaw-template-manifest-link-unpacked-");
    await mkdir(join(project, "manifest"));
    await rename(join(project, "CLAW.md"), join(project, "manifest", "source.md"));
    await symlink("manifest/source.md", join(project, "CLAW.md"), "file");

    await expect(validateTemplateProject(project)).resolves.toMatchObject({ ok: true });
    await buildTemplateProject(project, output);
    await tar.x({ cwd: unpacked, file: output, strict: true });

    expect((await lstat(join(unpacked, "package", "CLAW.md"))).isFile()).toBe(true);
    expect(await readFile(join(unpacked, "package", "CLAW.md"), "utf8")).toContain(
      "You are the demo Template.",
    );
  });

  it.each([".git/CLAW.md", "node_modules/example/CLAW.md"])(
    "rejects a CLAW.md symlink into excluded tree %s",
    async (targetPath) => {
      await mkdir(dirname(join(project, targetPath)), { recursive: true });
      await rename(join(project, "CLAW.md"), join(project, targetPath));
      await symlink(targetPath, join(project, "CLAW.md"), "file");

      await expectInvalidProject(project, "project_not_found");
    },
  );

  it("rejects a CLAW.md symlink that escapes the project", async () => {
    const outside = tempDirs.make("openclaw-template-manifest-outside-");
    await rename(join(project, "CLAW.md"), join(outside, "CLAW.md"));
    await symlink(join(outside, "CLAW.md"), join(project, "CLAW.md"), "file");

    await expectInvalidProject(project, "project_not_found");
  });

  it.each([".git/config", "workspace/node_modules/example/secret.md"])(
    "rejects an explicitly selected source from %s",
    async (sourcePath) => {
      await mkdir(dirname(join(project, sourcePath)), { recursive: true });
      await writeFile(join(project, sourcePath), "sensitive local state\n");
      await replaceManifest(project, "workspace/reference.md", sourcePath);
      await expectInvalidProject(project, "project_excluded_source");
      await expect(buildTemplateProject(project, output)).rejects.toMatchObject({
        code: "project_invalid",
      } satisfies Partial<TemplateProjectError>);
    },
  );

  it("rejects a custom profile selected from an excluded tree", async () => {
    await rename(
      join(project, "profiles", "openclaw.yml"),
      join(project, "profiles", "unused.yml"),
    );
    await mkdir(join(project, ".git"), { recursive: true });
    await writeFile(join(project, ".git", "profile.yaml"), "schemaVersion: 1\nagent: {}\n");
    await replaceManifest(
      project,
      "agent:\n  id: demo-template",
      "agent:\n  id: demo-template\nmetadata:\n  openclaw.config: .git/profile.yaml",
    );
    await expectInvalidProject(project, "project_excluded_source");
  });

  it.runIf(process.platform !== "win32")(
    "rejects a workspace source that portably collides with CLAW.md",
    async ({ skip }) => {
      const canonical = await lstat(join(project, "CLAW.md"));
      const folded = await lstat(join(project, "claw.md")).catch(() => undefined);
      if (folded && canonical.dev === folded.dev && canonical.ino === folded.ino) {
        // This collision needs two distinct case-folded names, unavailable on this filesystem.
        skip();
        return;
      }
      await writeFile(join(project, "claw.md"), "# Conflicting source\n");
      await replaceManifest(project, "workspace/reference.md", "claw.md");
      await expectInvalidProject(project, "project_path_collision");
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a workspace source that portably collides with a custom profile",
    async () => {
      await relocateProfile(project, "custom.yaml");
      await writeFile(join(project, "profiles", "CUSTOM.yaml"), "schemaVersion: 1\nagent: {}\n");
      await replaceManifest(project, "workspace/reference.md", "profiles/CUSTOM.yaml");
      await expectInvalidProject(project, "project_path_collision");
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects Unicode-normalization collisions between workspace sources",
    async () => {
      const composed = "workspace/caf\u00e9.md";
      const decomposed = "workspace/cafe\u0301.md";
      await replaceManifest(
        project,
        "    - source: workspace/reference.md\n      path: reference.md",
        [
          `    - source: ${JSON.stringify(composed)}`,
          "      path: composed.md",
          `    - source: ${JSON.stringify(decomposed)}`,
          "      path: decomposed.md",
        ].join("\n"),
      );
      await writeFile(join(project, composed), "# Composed\n");
      await writeFile(join(project, decomposed), "# Decomposed\n");

      await expectInvalidProject(project, "project_path_collision");
    },
  );

  it("preserves an existing build destination", async () => {
    await writeFile(output, "keep this artifact\n");

    await expect(buildTemplateProject(project, output)).rejects.toMatchObject({
      code: "artifact_exists",
    } satisfies Partial<TemplateProjectError>);
    expect(await readFile(output, "utf8")).toBe("keep this artifact\n");
  });

  it("rejects ambiguous nested project discovery", async () => {
    const inner = join(project, "examples", "nested");
    await writeRichProject(inner);

    const result = await validateTemplateProject(join(inner, "CLAW.md"));

    assert(!result.ok);
    expect(result.diagnostics.map((item) => item.code)).toContain("ambiguous_project_root");
  });

  it("changes the artifact digest when a declared input changes", async () => {
    const first = await buildTemplateProject(project, output);
    await writeFile(join(project, "workspace", "reference.md"), "# Changed reference\n");
    const second = await buildTemplateProject(project, join(dirname(output), "second.tgz"));

    expect(first.integrity).not.toBe(second.integrity);
  });
});
