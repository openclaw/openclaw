import { readFile, writeFile } from "node:fs/promises";
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

it("reads the historical CLAW.md selector only at the verified published-artifact boundary", async () => {
  const f = await fixture({ claw: "CLAW.md" });
  await expect(f.read()).resolves.toMatchObject({
    manifest: { agent: { id: "published-template" } },
    source: {
      name: packageName,
      version,
      integrityKind: "artifact",
      integrity: `sha256:${artifactSha256}`,
      byteLength: 321,
    },
  });
  expect(await readFile(join(f.root, "package.json"))).toEqual(f.metadata);
  expect(await readTemplateManifestFile(f.root)).toMatchObject({ ok: false });
  expect(await validateTemplateProject(f.root)).toMatchObject({ ok: false });
  await expect(buildTemplateProject(f.root, join(f.root, "new.tgz"))).rejects.toThrow();
});

it.each([
  { template: "CLAW.md", claw: "CLAW.md" },
  { template: "CLAW.md", claw: "other.json" },
  { template: null, claw: "CLAW.md" },
])("rejects dual selectors regardless of their values: %j", async (selectors) => {
  const f = await fixture(selectors);
  await expect(f.read()).rejects.toMatchObject({ code: "clawhub_manifest_invalid" });
  expect(await readTemplateManifestFile(f.root)).toMatchObject({ ok: false });
  expect(await validateTemplateProject(f.root)).toMatchObject({ ok: false });
});

it.each(["template.json", "../CLAW.md", "claw.md"])(
  "does not broaden the published legacy selector to %s",
  async (claw) => {
    const f = await fixture({ claw });
    await expect(f.read()).rejects.toMatchObject({ code: "clawhub_manifest_invalid" });
  },
);

it("keeps current authoring canonical and preserves the exact release identity check", async () => {
  const f = await fixture({ template: "CLAW.md" });
  await expect(f.read()).resolves.toMatchObject({ source: { name: packageName, version } });
  expect(await validateTemplateProject(f.root)).toMatchObject({ ok: true });
  await expect(f.read("0.1.2")).rejects.toMatchObject({ code: "clawhub_identity_mismatch" });
  expect(await readFile(join(f.root, "package.json"))).toEqual(f.metadata);
});
