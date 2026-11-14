import { link, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, assert, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { CRON_JOB_SCRATCH_MAX_BYTES } from "../cron/scratch-contract.js";
import { buildTemplateAddPlan } from "./lifecycle.js";
import { readTemplateManifestFile } from "./reader.js";
import { parseTemplateManifest } from "./schema.js";
import { TEMPLATE_ADD_PLAN_SCHEMA_VERSION } from "./types.js";

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

  async function heartbeatFixture(bytes: Buffer) {
    const root = tempDirs.make("openclaw-template-heartbeat-");
    await mkdir(join(root, "workspace"), { recursive: true });
    await writeFile(
      join(root, "CLAW.md"),
      markdown(
        "workspace:\n  bootstrapFiles:\n    HEARTBEAT.md:\n      source: workspace/HEARTBEAT.md\n---\nHeartbeat.",
      ),
      "utf8",
    );
    await writeFile(join(root, "workspace", "HEARTBEAT.md"), bytes);
    return join(root, "CLAW.md");
  }

  it("reports a mapped HEARTBEAT.md larger than the cron scratch limit", async () => {
    const manifestPath = await heartbeatFixture(Buffer.alloc(324_000, 0x61));

    const result = await readTemplateManifestFile(manifestPath);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual({
      level: "error",
      code: "workspace_heartbeat_too_large",
      phase: "parse",
      path: "$.workspace.bootstrapFiles.HEARTBEAT.md",
      message: `HEARTBEAT.md exceeds ${CRON_JOB_SCRATCH_MAX_BYTES} bytes (324000 bytes provided).`,
    });
  });

  it("reports a mapped HEARTBEAT.md that is not valid UTF-8", async () => {
    const manifestPath = await heartbeatFixture(
      Buffer.concat([Buffer.from("Heartbeat.md\n", "utf8"), Buffer.from([0xff, 0xfe])]),
    );

    const result = await readTemplateManifestFile(manifestPath);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        code: "workspace_heartbeat_invalid_utf8",
        path: "$.workspace.bootstrapFiles.HEARTBEAT.md",
        message: expect.stringContaining("HEARTBEAT.md"),
      }),
    );
  });

  it("accepts a mapped HEARTBEAT.md exactly at the cron scratch limit", async () => {
    const manifestPath = await heartbeatFixture(Buffer.alloc(CRON_JOB_SCRATCH_MAX_BYTES, 0x61));

    expect(await readTemplateManifestFile(manifestPath)).toMatchObject({ ok: true });
  });

  it("reports an oversized workspace file destined for HEARTBEAT.md at its manifest path", async () => {
    const root = tempDirs.make("openclaw-template-heartbeat-files-");
    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(
      join(root, "CLAW.md"),
      markdown(
        "workspace:\n  files:\n    - { source: notes/heartbeat.md, path: HEARTBEAT.md }\n---\nHeartbeat.",
      ),
      "utf8",
    );
    await writeFile(join(root, "notes", "heartbeat.md"), Buffer.alloc(324_000, 0x61));

    const result = await readTemplateManifestFile(join(root, "CLAW.md"));

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "workspace_heartbeat_too_large",
        path: "$.workspace.files[0]",
      }),
    );
  });

  async function collidingWorkspaceFileRoot(path: string) {
    const root = tempDirs.make("openclaw-template-heartbeat-collision-");
    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(
      join(root, "CLAW.md"),
      markdown(
        `workspace:\n  files:\n    - { source: notes/big.md, path: ${path} }\n---\nHeartbeat.`,
      ),
      "utf8",
    );
    await writeFile(join(root, "notes", "big.md"), Buffer.alloc(324_000, 0x61));
    return root;
  }

  it.each(["HEARTBEAT.md/notes.md", "heartbeat.md"])(
    "accepts an oversized ordinary workspace file declared as %s",
    async (path) => {
      const root = await collidingWorkspaceFileRoot(path);

      const result = await readTemplateManifestFile(join(root, "CLAW.md"));

      expect(result.ok).toBe(true);
    },
  );

  it("keeps Add planning a blocked plan when HEARTBEAT.md cannot become scratch", async () => {
    const parsed = parseTemplateManifest({
      schemaVersion: 1,
      agent: { id: "triage" },
      workspace: { bootstrapFiles: { "HEARTBEAT.md": { source: "HEARTBEAT.md" } } },
    });
    assert(parsed.ok, "expected fixture manifest to parse");
    const root = tempDirs.make("openclaw-template-heartbeat-plan-");
    await writeFile(join(root, "HEARTBEAT.md"), Buffer.alloc(324_000, 0x61));

    const plan = await buildTemplateAddPlan({
      manifest: parsed.manifest,
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

    expect(plan.schemaVersion).toBe(TEMPLATE_ADD_PLAN_SCHEMA_VERSION);
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({
        level: "error",
        code: "workspace_heartbeat_too_large",
        path: "$.workspace.bootstrapFiles.HEARTBEAT.md",
        message: expect.stringContaining("HEARTBEAT.md"),
      }),
    );
    expect(
      plan.actions.filter(
        (action) => action.kind === "cronJob" && action.id === "$portable-heartbeat",
      ),
    ).toEqual([expect.objectContaining({ blocked: true })]);
    expect(plan.actions.some((action) => "scratch" in action && action.scratch !== undefined)).toBe(
      false,
    );
  });

  it("keeps an oversized workspace file that only collides with HEARTBEAT.md an ordinary file", async () => {
    const parsed = parseTemplateManifest({
      schemaVersion: 1,
      agent: { id: "triage" },
      workspace: { files: [{ source: "notes/big.md", path: "HEARTBEAT.md/notes.md" }] },
    });
    assert(parsed.ok, "expected fixture manifest to parse");
    const root = tempDirs.make("openclaw-template-heartbeat-collision-plan-");
    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(join(root, "notes", "big.md"), Buffer.alloc(324_000, 0x61));

    const plan = await buildTemplateAddPlan({
      manifest: parsed.manifest,
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

    expect(plan.blockers).toEqual([]);
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: "workspaceFile",
        id: "HEARTBEAT.md/notes.md",
        blocked: false,
      }),
    );
    expect(plan.actions.some((action) => action.kind === "cronJob")).toBe(false);
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
