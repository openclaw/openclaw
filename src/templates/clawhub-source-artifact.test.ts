import { mkdir, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readVerifiedArtifactSource } from "./clawhub-source-artifact.js";
import { buildTemplateProject } from "./project-build.js";
import { validateTemplateProject } from "./project.js";
import { readTemplateManifestFile } from "./reader.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const packageName = "@fixture/published-template";
const version = "0.1.1";
const artifactSha256 = "a".repeat(64);
async function fixture(selectors: Record<string, unknown>) {
  const root = dirs.make("published-template-selector-");
  const metadata = Buffer.from(
    `${JSON.stringify({ name: packageName, version, openclaw: selectors })}\n`,
  );
  await writeFile(join(root, "package.json"), metadata);
  await writeFile(
    join(root, "CLAW.md"),
    "---\nschemaVersion: 1\nagent: { id: published-template }\n---\nPublished instructions.\n",
  );
  return {
    root,
    metadata,
    read: (selectedVersion = version) =>
      readVerifiedArtifactSource({
        sourceRoot: root,
        packageName,
        version: selectedVersion,
        artifactSha256,
        artifactByteLength: 321,
      }),
  };
}

it("rejects the obsolete openclaw.claw selector even for a verified release", async () => {
  const f = await fixture({ claw: "CLAW.md" });
  await expect(f.read()).rejects.toMatchObject({ code: "clawhub_manifest_invalid" });
  expect(await readFile(join(f.root, "package.json"))).toEqual(f.metadata);
});

it("includes safe manifest diagnostics when a verified release is invalid", async () => {
  const f = await fixture({ template: "CLAW.md" });
  await writeFile(
    join(f.root, "CLAW.md"),
    '---\nschemaVersion: 1\nagent: { id: published-template }\nmetadata: { "untrusted\\e[31m": 1 }\nmcpServers:\n  first: { url: https://first.example/mcp }\n  second: { url: https://second.example/mcp }\n---\nPublished instructions.\n',
  );

  const error = await f.read().catch((cause: unknown) => cause);
  expect(error).toMatchObject({
    code: "clawhub_manifest_invalid",
    message: expect.stringContaining("invalid_manifest $.mcpServers.first: Invalid input"),
  });
  expect(error).toHaveProperty(
    "message",
    expect.stringContaining("invalid_manifest $.mcpServers.second: Invalid input"),
  );
  expect(error).toHaveProperty("message", expect.not.stringContaining("\u001b"));
});

it.each([false, true])(
  "keeps malformed manifest filenames package-relative (linked=%s)",
  async (linked) => {
    const f = await fixture({ template: "nested/CLAW.md" });
    await mkdir(join(f.root, "nested"));
    await writeFile(join(f.root, "nested", "CLAW.md"), "---\nschemaVersion: [1\n---\n");
    let sourceRoot = f.root;
    if (linked) {
      sourceRoot = join(dirs.make("published-template-link-"), "package");
      await symlink(f.root, sourceRoot, process.platform === "win32" ? "junction" : "dir");
    }

    const error = await readVerifiedArtifactSource({
      sourceRoot,
      packageName,
      version,
      artifactSha256,
      artifactByteLength: 321,
    }).catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: "clawhub_manifest_invalid",
      message: expect.stringContaining(
        `invalid_template_frontmatter $: Could not parse ${join("nested", "CLAW.md")}:`,
      ),
    });
    expect(error).toHaveProperty("message", expect.stringContaining("Flow sequence"));
    expect(error).toHaveProperty("message", expect.not.stringContaining(await realpath(f.root)));
    expect(error).toHaveProperty("message", expect.not.stringContaining(sourceRoot));
  },
);

it.each(["CLAW.md", null])(
  "rejects a legacy key alongside the canonical selector: %s",
  async (claw) => {
    const f = await fixture({ template: "CLAW.md", claw });
    await expect(f.read()).rejects.toMatchObject({ code: "clawhub_manifest_invalid" });
    expect(await validateTemplateProject(f.root)).toMatchObject({ ok: false });
    await expect(buildTemplateProject(f.root, join(f.root, "new.tgz"))).rejects.toThrow();
  },
);

it("rejects JSON Template manifests through package and direct-file admission", async () => {
  const f = await fixture({ template: "template.json" });
  const manifest = join(f.root, "template.json");
  await writeFile(manifest, JSON.stringify({ schemaVersion: 1, agent: { id: "legacy-json" } }));
  await expect(f.read()).rejects.toMatchObject({ code: "clawhub_manifest_invalid" });
  expect(await readTemplateManifestFile(f.root)).toMatchObject({ ok: false });
  expect(await readTemplateManifestFile(manifest)).toMatchObject({
    ok: false,
    diagnostics: [expect.objectContaining({ code: "unsupported_manifest_format" })],
  });
});

it("consumes a published canonical CLAW.md at a nested package-relative path", async () => {
  const f = await fixture({ template: "nested/CLAW.md" });
  await mkdir(join(f.root, "nested"));
  const manifestPath = join(f.root, "nested", "CLAW.md");
  await rename(join(f.root, "CLAW.md"), manifestPath);
  await expect(f.read()).resolves.toMatchObject({
    manifest: { agent: { id: "published-template" } },
    source: {
      kind: "package",
      name: packageName,
      version,
      manifestPath: await realpath(manifestPath),
      integrityKind: "artifact",
    },
  });
  expect(await readFile(join(f.root, "package.json"))).toEqual(f.metadata);
});

it("keeps current authoring canonical and preserves the exact release identity check", async () => {
  const f = await fixture({ template: "CLAW.md" });
  await expect(f.read()).resolves.toMatchObject({
    source: {
      name: packageName,
      version,
      integrityKind: "artifact",
      integrity: `sha256:${artifactSha256}`,
      byteLength: 321,
    },
  });
  expect(await validateTemplateProject(f.root)).toMatchObject({ ok: true });
  await expect(f.read("0.1.2")).rejects.toMatchObject({ code: "clawhub_identity_mismatch" });
  expect(await readFile(join(f.root, "package.json"))).toEqual(f.metadata);
});
