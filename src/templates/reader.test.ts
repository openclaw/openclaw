import { link, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, assert, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildTemplateAddPlan } from "./lifecycle.js";
import { readTemplateManifestFile } from "./reader.js";
import { parseTemplateManifest } from "./schema.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const markdown = (content: string) => `---\nschemaVersion: 1\nagent: { id: triage }\n${content}`;
function expectReadError(
  result: Awaited<ReturnType<typeof readTemplateManifestFile>>,
  code: string,
) {
  expect(result.ok).toBe(false);
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code }));
}
function readFailure(code: string, message: unknown) {
  return { ok: false, diagnostics: [{ level: "error", code, phase: "parse", path: "$", message }] };
}
const manifestJson = JSON.stringify({
  schemaVersion: 1,
  agent: { id: "reader-agent", name: "Café" },
});
const packageJson = JSON.stringify({
  name: "reader-package",
  version: "1.0.0",
  description: "Café",
  openclaw: { template: "CLAW.md" },
});

async function sourceFixture(kind: "package" | "manifest") {
  const root = tempDirs.make("openclaw-template-source-");
  const manifestPath = join(root, "CLAW.md");
  const packagePath = join(root, "package.json");
  const manifest = ["---", manifestJson, "---", ""].join("\n");
  await writeFile(manifestPath, manifest);
  await writeFile(packagePath, packageJson);
  return {
    path: kind === "package" ? packagePath : manifestPath,
    source: kind === "package" ? root : manifestPath,
    text: kind === "package" ? packageJson : manifest,
  };
}

describe("Template source reader", () => {
  it.each([
    { kind: "package", code: "invalid_json" },
    { kind: "manifest", code: "invalid_template_markdown_utf8" },
  ] as const)(
    "rejects malformed UTF-8 $kind bytes without replacement decoding",
    async ({ kind, code }) => {
      const { path, source, text } = await sourceFixture(kind);
      await writeFile(path, Buffer.from(text, "latin1"));
      expectReadError(await readTemplateManifestFile(source), code);
      await writeFile(path, text, "utf8");
      expect(await readTemplateManifestFile(source)).toMatchObject({
        ok: true,
        manifest: { agent: { name: "Café" } },
      });
    },
  );

  it("reports BOM-prefixed package JSON at its source path", async () => {
    const { path, source, text } = await sourceFixture("package");
    await writeFile(path, "\uFEFF" + text);
    expect(await readTemplateManifestFile(source)).toEqual(
      readFailure(
        "invalid_json",
        expect.stringContaining("Could not parse " + (await realpath(path)) + ":"),
      ),
    );
  });

  it.each([
    { kind: "package", maxBytes: 256 * 1024, code: "package_read_failed_too_large" },
    { kind: "manifest", maxBytes: 1024 * 1024, code: "read_failed_too_large" },
  ] as const)("keeps the distinct $kind byte limit", async ({ kind, maxBytes, code }) => {
    const { path, source, text } = await sourceFixture(kind);
    const bytes = Buffer.from(text);
    const raw = Buffer.concat([bytes, Buffer.alloc(maxBytes - bytes.length, 0x20)]);
    await writeFile(path, raw);
    expect(await readTemplateManifestFile(source)).toMatchObject({
      ok: true,
      manifest: { agent: { id: "reader-agent", name: "Café" } },
    });
    await writeFile(path, Buffer.concat([raw, Buffer.from(" ")]));
    expect(await readTemplateManifestFile(source)).toEqual(
      readFailure(code, (await realpath(path)) + " exceeds " + maxBytes + " bytes."),
    );
  });

  it("binds package whitespace bytes even when identity and byte length are unchanged", async () => {
    const { path: packagePath, source } = await sourceFixture("package");
    await writeFile(packagePath, `${packageJson}\n`);
    const first = await readTemplateManifestFile(source);
    await writeFile(packagePath, `${packageJson} `);
    const second = await readTemplateManifestFile(source);

    assert(first.ok && second.ok, "expected both package documents to parse");
    expect({ manifest: second.manifest, snapshot: second.snapshot, source: second.source }).toEqual(
      {
        manifest: first.manifest,
        snapshot: first.snapshot,
        source: { ...first.source, integrity: expect.any(String) },
      },
    );
    expect(second.source.integrity).not.toBe(first.source.integrity);
  });

  it("reads an unpackaged Template directory without bypassing declared package metadata", async () => {
    const root = tempDirs.make("openclaw-standalone-template-");
    const source = join(root, "CLAW.md");
    await writeFile(
      source,
      "---\nschemaVersion: 1\nagent:\n  id: researcher\n  name: Café\n---\nResearch carefully.\n",
    );
    const standalone = await readTemplateManifestFile(source);
    expect(standalone).toMatchObject({ ok: true, manifest: { agent: { name: "Café" } } });
    expect(await readTemplateManifestFile(root)).toEqual(standalone);

    await writeFile(join(root, "package.json"), JSON.stringify({ name: "invalid-package" }));
    expect(await readTemplateManifestFile(root)).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "invalid_package_metadata" })],
    });
  });

  it("rejects a body with a case-folded nested workspace collision", async () => {
    const root = tempDirs.make("openclaw-template-markdown-soul-hierarchy-");
    const manifestPath = join(root, "CLAW.md");
    await writeFile(
      manifestPath,
      markdown(
        "workspace:\n  files:\n    - { source: package.json, path: soul.MD/child }\n---\nPortable soul",
      ),
      "utf8",
    );

    const result = await readTemplateManifestFile(manifestPath);

    expectReadError(result, "template_body_soul_conflict");
  });

  it("blocks a direct add plan when implicit SOUL.md owns an ancestor path", async () => {
    const parsed = parseTemplateManifest({
      schemaVersion: 1,
      agent: { id: "triage" },
      workspace: { files: [{ source: "package.json", path: "SOUL.md/child" }] },
    });
    assert(parsed.ok, "expected fixture manifest to parse");
    const root = tempDirs.make("openclaw-template-markdown-soul-direct-plan-");
    await writeFile(join(root, "package.json"), "{}", "utf8");
    const plan = await buildTemplateAddPlan({
      manifest: parsed.manifest,
      templateMarkdownBody: Buffer.from("Portable soul"),
      source: {
        kind: "development",
        name: "local:triage",
        version: "0.0.0-development",
        packageRoot: root,
        manifestPath: join(root, "CLAW.md"),
        integrityKind: "development-snapshot",
        integrity: "sha256:fixture",
        byteLength: 1,
      },
      context: { workspace: join(root, "workspace") },
    });

    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "template_body_soul_conflict" }),
    );
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ id: "SOUL.md", sourceKind: "templateMarkdownBody", blocked: true }),
    );
    expect(JSON.stringify(plan)).not.toContain("Portable soul");
  });

  it("rejects a hardlinked CLAW.md before planning", async () => {
    const root = tempDirs.make("openclaw-template-markdown-hardlink-");
    const original = join(root, "original.md");
    const manifestPath = join(root, "CLAW.md");
    await writeFile(original, markdown("---\nPortable soul\n"), "utf8");
    await link(original, manifestPath);

    const result = await readTemplateManifestFile(manifestPath);

    expectReadError(result, "read_failed");
  });
});
