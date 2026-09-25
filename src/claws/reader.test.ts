import { link, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { readClawManifestFile } from "./reader.js";
import { parseClawManifest } from "./schema.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const manifestJson = JSON.stringify({
  schemaVersion: 1,
  agent: { id: "reader-agent", name: "Café" },
});
const packageJson = JSON.stringify({
  name: "reader-package",
  version: "1.0.0",
  openclaw: { claw: "openclaw.claw.json" },
});

describe("Claw source reader", () => {
  it.each([
    { kind: "package", input: "malformed" },
    { kind: "package", input: "BOM-prefixed" },
    { kind: "manifest", input: "malformed" },
    { kind: "manifest", input: "BOM-prefixed" },
  ])("reports $input $kind JSON at its source path", async ({ kind, input }) => {
    const root = tempDirs.make("openclaw-claw-json-diagnostic-");
    const manifestPath = join(root, "openclaw.claw.json");
    const packagePath = join(root, "package.json");
    await writeFile(manifestPath, manifestJson);
    await writeFile(packagePath, packageJson);
    const path = kind === "package" ? packagePath : manifestPath;
    const valid = kind === "package" ? packageJson : manifestJson;
    await writeFile(path, input === "malformed" ? "{" : `\uFEFF${valid}`);

    expect(await readClawManifestFile(kind === "package" ? root : path)).toEqual({
      ok: false,
      diagnostics: [
        {
          level: "error",
          code: "invalid_json",
          phase: "parse",
          path: "$",
          message: expect.stringContaining(`Could not parse ${await realpath(path)}:`),
        },
      ],
    });
  });

  it.each([
    { kind: "package", maxBytes: 256 * 1024, code: "package_read_failed_too_large" },
    { kind: "manifest", maxBytes: 1024 * 1024, code: "read_failed_too_large" },
  ])("keeps the distinct $kind byte limit", async ({ kind, maxBytes, code }) => {
    const root = tempDirs.make("openclaw-claw-json-limit-");
    const manifestPath = join(root, "openclaw.claw.json");
    const packagePath = join(root, "package.json");
    await writeFile(manifestPath, manifestJson);
    await writeFile(packagePath, packageJson);
    const path = kind === "package" ? packagePath : manifestPath;
    const json = Buffer.from(kind === "package" ? packageJson : manifestJson);
    const raw = Buffer.concat([json, Buffer.alloc(maxBytes - json.length, 0x20)]);
    await writeFile(path, raw);
    const source = kind === "package" ? root : path;

    expect(await readClawManifestFile(source)).toMatchObject({
      ok: true,
      manifest: { agent: { id: "reader-agent", name: "Café" } },
    });

    await writeFile(path, Buffer.concat([raw, Buffer.from(" ")]));
    expect(await readClawManifestFile(source)).toEqual({
      ok: false,
      diagnostics: [
        {
          level: "error",
          code,
          phase: "parse",
          path: "$",
          message: `${await realpath(path)} exceeds ${maxBytes} bytes.`,
        },
      ],
    });
  });

  it("binds package whitespace bytes even when identity and byte length are unchanged", async () => {
    const root = tempDirs.make("openclaw-claw-package-json-integrity-");
    const packagePath = join(root, "package.json");
    await writeFile(join(root, "openclaw.claw.json"), manifestJson);
    await writeFile(packagePath, `${packageJson}\n`);
    const first = await readClawManifestFile(root);
    await writeFile(packagePath, `${packageJson} `);
    const second = await readClawManifestFile(root);

    if (!first.ok || !second.ok) {
      throw new Error("expected both package documents to parse");
    }
    expect(second.manifest).toEqual(first.manifest);
    expect(second.snapshot).toEqual(first.snapshot);
    expect(second.source).toEqual({
      ...first.source,
      integrity: expect.any(String),
    });
    expect(second.source.integrity).not.toBe(first.source.integrity);
  });

  it("reads an unpackaged Claw directory without bypassing declared package metadata", async () => {
    const root = tempDirs.make("openclaw-standalone-claw-");
    const source = join(root, "CLAW.md");
    await writeFile(
      source,
      "---\nschemaVersion: 1\nagent:\n  id: researcher\n---\nResearch carefully.\n",
    );
    const standalone = await readClawManifestFile(source);
    expect(standalone.ok).toBe(true);
    expect(await readClawManifestFile(root)).toEqual(standalone);

    await writeFile(join(root, "package.json"), JSON.stringify({ name: "invalid-package" }));
    expect(await readClawManifestFile(root)).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "invalid_package_metadata" })],
    });
  });

  it("preserves non-ASCII UTF-8 frontmatter values", async () => {
    const root = tempDirs.make("openclaw-claw-markdown-unicode-");
    const manifestPath = join(root, "CLAW.md");
    await writeFile(
      manifestPath,
      "---\nschemaVersion: 1\nagent: { id: cafe, name: Café }\n---\nPortable soul\n",
      "utf8",
    );

    const result = await readClawManifestFile(manifestPath);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.agent.name).toBe("Café");
    }
  });

  it.each([
    ["nested", "SOUL.md/child"],
    ["case-folded nested", "soul.MD/child"],
    ["Unicode-normalized nested", "SOUL.md/cafe\u0301"],
  ])("rejects a body with a %s workspace collision", async (_label, destination) => {
    const root = tempDirs.make("openclaw-claw-markdown-soul-hierarchy-");
    const manifestPath = join(root, "CLAW.md");
    await writeFile(
      manifestPath,
      [
        "---",
        "schemaVersion: 1",
        "agent: { id: triage }",
        "workspace:",
        "  files:",
        `    - { source: package.json, path: ${JSON.stringify(destination)} }`,
        "---",
        "Portable soul",
      ].join("\n"),
      "utf8",
    );

    const result = await readClawManifestFile(manifestPath);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "claw_body_soul_conflict" }),
    );
  });

  it("blocks a direct add plan when implicit SOUL.md owns an ancestor path", async () => {
    const parsed = parseClawManifest({
      schemaVersion: 1,
      agent: { id: "triage" },
      workspace: { files: [{ source: "package.json", path: "SOUL.md/child" }] },
    });
    if (!parsed.ok) {
      throw new Error("expected fixture manifest to parse");
    }
    const root = tempDirs.make("openclaw-claw-markdown-soul-direct-plan-");
    await writeFile(join(root, "package.json"), "{}", "utf8");
    const plan = await buildClawAddPlan({
      manifest: parsed.manifest,
      clawMarkdownBody: Buffer.from("Portable soul"),
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
      expect.objectContaining({ code: "claw_body_soul_conflict" }),
    );
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ id: "SOUL.md", sourceKind: "clawMarkdownBody", blocked: true }),
    );
    expect(JSON.stringify(plan)).not.toContain("Portable soul");
  });

  it("rejects a hardlinked CLAW.md before planning", async () => {
    const root = tempDirs.make("openclaw-claw-markdown-hardlink-");
    const original = join(root, "original.md");
    const manifestPath = join(root, "CLAW.md");
    await writeFile(
      original,
      "---\nschemaVersion: 1\nagent: { id: triage }\n---\nPortable soul\n",
      "utf8",
    );
    await link(original, manifestPath);

    const result = await readClawManifestFile(manifestPath);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "read_failed" }));
  });
});
