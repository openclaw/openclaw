import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { crc32 } from "node:zlib";
import { encodePngRgba } from "rastermill";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  convertImageToJpeg,
  createImageProcessor,
  readImageProbeFromHeader,
} from "../media/image-ops.js";
import { AVATAR_MAX_BYTES } from "../shared/avatar-limits.js";
import { createTemplateDraft, prepareTemplateDraft } from "./draft.js";
import { createResearchBriefProposal } from "./draft.test-support.js";
import { buildTemplateAddPlan } from "./lifecycle.js";
import { extractBuiltTemplateArtifact } from "./project-build.js";
import { parseTemplateMarkdown, readTemplateManifestFile } from "./reader.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const proposal = createResearchBriefProposal();

async function draftFixture(value: unknown = proposal) {
  const workspaceDir = tempDirs.make("template-draft-");
  const draft = await createTemplateDraft(workspaceDir);
  await writeFile(draft.path, JSON.stringify(value));
  const target = { workspaceDir, draftId: draft.draftId, publisher: "maker" };
  return { ...draft, workspaceDir, target, prepare: () => prepareTemplateDraft(target) };
}
const expectNoSharedDraft = (workspaceDir: string) =>
  expect(
    readFile(join(workspaceDir, ".openclaw/template-drafts/current.json"), "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });

describe("agent-created Template drafts", () => {
  it.each(["bundled", "clawhub"] as const)(
    "excludes only the selected %s skill when its path matches a registry ref",
    async (source) => {
      const { target, prepare } = await draftFixture({
        ...proposal,
        manifest: proposal.manifest.replace(
          "---\nCompare",
          "skills:\n  - path: research\n  - ref: research\n    version: 1.0.0\n---\nCompare",
        ),
        files: [
          {
            path: "research/SKILL.md",
            content:
              "---\nname: local-research\ndescription: Compare public research sources.\n---\nCite primary sources.\n",
          },
        ],
      });
      await using initial = await prepare();
      const selected = initial.items.find(
        (item) => item.kind === "skill" && item.detail.startsWith(source),
      );
      expect(selected).toBeDefined();
      await using prepared = await prepareTemplateDraft({
        ...target,
        choices: { name: proposal.name, description: "", excluded: [selected!.id] },
      });
      expect(
        prepared.items.filter((item) => item.kind === "skill").map((item) => item.included),
      ).toEqual(source === "bundled" ? [false, true] : [true, false]);
      const manifest = prepared.files.find((file) => file.path === "CLAW.md")!;
      expect(parseTemplateMarkdown(Buffer.from(manifest.content ?? ""), "CLAW.md")).toMatchObject({
        ok: true,
        value: {
          skills:
            source === "bundled" ? [{ ref: "research", version: "1.0.0" }] : [{ path: "research" }],
        },
      });
      expect(prepared.files.some((file) => file.path === "research/SKILL.md")).toBe(
        source === "clawhub",
      );
    },
  );

  it.each([false, true, undefined])("preserves automation enabled=%s", async (enabled) => {
    const { prepare } = await draftFixture({
      ...proposal,
      manifest: proposal.manifest.replace(
        "---\nCompare",
        `automations:\n  - id: weekly\n    ${enabled === undefined ? "" : `enabled: ${enabled}\n    `}schedule: { cron: "0 9 * * 1", timezone: UTC }\n    session: isolated\n    message: Prepare a brief.\n---\nCompare`,
      ),
    });
    await using prepared = await prepare();
    expect(prepared.items.find((item) => item.kind === "automation")).toMatchObject({
      label: "weekly",
      detail: `0 9 * * 1 · UTC · ${enabled === false ? "Disabled" : "Enabled"}`,
      automation: { enabled: enabled !== false },
      included: true,
    });
    await using extracted = await extractBuiltTemplateArtifact(prepared.artifact);
    expect(
      parseTemplateMarkdown(await readFile(join(extracted.packageRoot, "CLAW.md")), "CLAW.md"),
    ).toMatchObject({
      ok: true,
      value: { automations: [enabled === undefined ? { id: "weekly" } : { enabled }] },
    });
  });

  it("keeps the package slug while showing a title-cased agent name", async () => {
    const { target, prepare } = await draftFixture();
    await using initial = await prepare();
    expect(initial.displayName).toBe("Research Brief");

    const choices = {
      name: "research-brief",
      displayName: "  Engineering Partner  ",
      description: " A collaborative engineering partner. ",
      excluded: [],
    };
    await using prepared = await prepareTemplateDraft({ ...target, choices });
    expect(prepared).toMatchObject({
      name: "@maker/research-brief",
      displayName: "Engineering Partner",
    });
    expect(prepared.files.find((file) => file.path === "CLAW.md")?.content).toContain(
      "id: research-brief\n  name: Engineering Partner",
    );
  });

  it("keeps the CLAW.md agent name and description when the seeded description is untouched", async () => {
    const manifestName = "macOS Follow-up Brief";
    const manifestDescription = "Compare primary sources into a cited brief.";
    const workspaceDir = tempDirs.make("template-draft-identity-");
    const draft = await createTemplateDraft(workspaceDir);
    const seeded = JSON.parse(await readFile(draft.path, "utf8"));
    await writeFile(
      draft.path,
      JSON.stringify({
        ...proposal,
        description: seeded.description,
        manifest: proposal.manifest.replace(
          "id: research-brief\n",
          `id: research-brief\n  name: ${manifestName}\n  description: ${manifestDescription}\n`,
        ),
      }),
    );
    const target = { workspaceDir, draftId: draft.draftId, publisher: "maker" };
    const manifestOf = (prepared: { files: Array<{ path: string; content?: string }> }) =>
      prepared.files.find((file) => file.path === "CLAW.md")?.content ?? "";

    await using initial = await prepareTemplateDraft(target);
    expect(initial).toMatchObject({ displayName: manifestName, description: manifestDescription });
    expect(manifestOf(initial)).toContain(
      `name: ${manifestName}\n  description: ${manifestDescription}`,
    );

    const choices = { name: "research-brief", description: "", excluded: [] };
    await using cleared = await prepareTemplateDraft({ ...target, choices });
    expect(cleared.description).toBe("");
    expect(manifestOf(cleared)).not.toContain(manifestDescription);
  });

  it("builds only the reviewed proposal, excluding the source workspace and private draft metadata", async () => {
    const workspaceDir = tempDirs.make("template-draft-privacy-");
    await writeFile(join(workspaceDir, "MEMORY.md"), "PRIVATE_MEMORY_SENTINEL");
    await writeFile(join(workspaceDir, "USER.md"), "PRIVATE_PERSON_SENTINEL");
    await writeFile(join(workspaceDir, ".env"), "PRIVATE_CREDENTIAL_SENTINEL");
    const draft = await createTemplateDraft(workspaceDir);
    expect(await readFile(draft.path, "utf8")).toContain('"name": "my-template"');
    await expectNoSharedDraft(workspaceDir);
    await writeFile(draft.path, JSON.stringify(proposal));

    await using prepared = await prepareTemplateDraft({
      workspaceDir,
      draftId: draft.draftId,
      publisher: "maker",
    });
    expect(prepared.name).toBe("@maker/research-brief");
    expect(prepared.files.map((file) => file.path).toSorted()).toEqual(["CLAW.md", "package.json"]);
    await using extracted = await extractBuiltTemplateArtifact(prepared.artifact);
    const manifest = await readFile(join(extracted.packageRoot, "CLAW.md"), "utf8");
    expect(manifest).toContain(proposal.scope.authority);
    expect(manifest).not.toMatch(/PRIVATE_|template-drafts/);
    expect(JSON.parse(await readFile(join(extracted.packageRoot, "package.json"), "utf8"))).toEqual(
      {
        name: "@maker/research-brief",
        version: "0.1.0",
        openclaw: { template: "CLAW.md" },
      },
    );
  });

  it("keeps overlapping drafts in distinct request-specific files", async () => {
    const workspaceDir = tempDirs.make("template-draft-overlap-");
    const [first, second] = await Promise.all([
      createTemplateDraft(workspaceDir),
      createTemplateDraft(workspaceDir),
    ]);

    expect(first.draftId).not.toBe(second.draftId);
    await writeFile(first.path, JSON.stringify({ ...proposal, name: "first-template" }));
    await writeFile(second.path, JSON.stringify({ ...proposal, name: "second-template" }));
    await expect(readFile(first.path, "utf8")).resolves.toContain('"name":"first-template"');
    await expect(readFile(second.path, "utf8")).resolves.toContain('"name":"second-template"');
    await expectNoSharedDraft(workspaceDir);
  });

  it.each([
    "MEMORY.md",
    "memory/notes.md",
    "USER.md",
    ".env",
    "sessions/log.jsonl",
    "history.JSONL",
    "../escape.md",
  ])("refuses private or escaping proposal files: %s", async (path) => {
    const { prepare } = await draftFixture({
      ...proposal,
      files: [{ path, content: "private context" }],
    });
    await expect(prepare()).rejects.toMatchObject({ code: "private_draft_file" });
  });

  it("refuses credential-like text without reflecting the credential in the error", async () => {
    const secret = `ghp_${"x".repeat(36)}`;
    const { prepare } = await draftFixture({
      ...proposal,
      manifest: `${proposal.manifest}\n${secret}`,
    });
    await expect(prepare()).rejects.toMatchObject({
      code: "sensitive_draft_content",
      message: expect.not.stringContaining(secret),
    });
  });

  it("rejects a draft file replaced by a symlink to source material", async () => {
    const { workspaceDir, path, prepare } = await draftFixture();
    const privatePath = join(workspaceDir, "private.json");
    await writeFile(privatePath, JSON.stringify(proposal));
    await unlink(path);
    await symlink(privatePath, path);
    await expect(prepare()).rejects.toThrow();
  });
});

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect width="40" height="20" fill="#f60"/></svg>';

describe("agent-created Template draft avatars", () => {
  async function avatarFixture(path: string | undefined, bytes?: Buffer | string) {
    const fixture = await draftFixture(
      path === undefined ? proposal : { ...proposal, avatar: path },
    );
    if (path !== undefined && bytes !== undefined) {
      await mkdir(dirname(join(fixture.workspaceDir, path)), { recursive: true });
      await writeFile(join(fixture.workspaceDir, path), bytes);
    }
    return fixture;
  }
  const manifestOf = (prepared: { files: Array<{ path: string; content?: string }> }) =>
    parseTemplateMarkdown(
      Buffer.from(prepared.files.find((file) => file.path === "CLAW.md")?.content ?? ""),
      "CLAW.md",
    );

  it.each([
    { path: "avatars/harbor.png", format: "PNG", bytes: async () => PNG, width: 1 },
    { path: "avatars/harbor.JPG", format: "JPEG", bytes: () => convertImageToJpeg(PNG), width: 1 },
    {
      path: "avatars/harbor.gif",
      format: "GIF",
      bytes: async () =>
        Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"),
      width: 1,
    },
    {
      path: "avatars/harbor.webp",
      format: "WebP",
      bytes: async () => (await createImageProcessor().encode(PNG, { format: "webp" })).data,
      width: 1,
    },
    { path: "harbor.svg", format: "SVG", bytes: async () => Buffer.from(SVG), width: 512 },
    {
      // The create-template inventory writes an avatar that the agent stores inline beside the draft.
      path: ".openclaw/template-drafts/inline-avatar.png",
      format: "draft-folder PNG",
      bytes: async () => PNG,
      width: 1,
    },
  ])("packages a $format avatar as the icon and the new agent's avatar", async (source) => {
    const { prepare } = await avatarFixture(source.path, await source.bytes());
    await using prepared = await prepare();

    expect(manifestOf(prepared)).toMatchObject({
      ok: true,
      value: {
        agent: { identity: { avatar: "avatars/avatar.png" } },
        workspace: { files: [{ source: "assets/icon.png", path: "avatars/avatar.png" }] },
      },
    });
    expect(prepared.items).toEqual([
      {
        id: "file:assets/icon.png",
        kind: "file",
        label: "assets/icon.png",
        detail: source.path,
        included: true,
      },
    ]);
    // The binary icon is listed without text content; every other file stays readable text.
    expect(prepared.files).toEqual([
      { path: "CLAW.md", content: expect.any(String) },
      { path: "assets/icon.png", workspacePaths: ["avatars/avatar.png"] },
      { path: "package.json", content: expect.any(String) },
    ]);
    await using extracted = await extractBuiltTemplateArtifact(prepared.artifact);
    const icon = await readFile(join(extracted.packageRoot, "assets/icon.png"));
    expect(readImageProbeFromHeader(icon)).toMatchObject({ format: "png", width: source.width });
    expect(icon.byteLength).toBeLessThanOrEqual(512 * 1024);
    expect(prepared.iconUrl).toBe(`data:image/png;base64,${icon.toString("base64")}`);

    // Add reads the same archive: the new agent gets this image as its avatar.
    const template = await readTemplateManifestFile(extracted.packageRoot);
    assert(template.ok, JSON.stringify(template));
    const plan = await buildTemplateAddPlan({
      ...template,
      context: { workspace: join(extracted.packageRoot, "added-workspace") },
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.agent.config.identity).toEqual({ avatar: "avatars/avatar.png" });
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: "workspaceFile",
        target: join(extracted.packageRoot, "added-workspace/avatars/avatar.png"),
        digest: `sha256:${createHash("sha256").update(icon).digest("hex")}`,
      }),
    );
  });

  it("shrinks an image that cannot fit ClawHub's 512 KiB icon limit at full size", async () => {
    const side = 640;
    const pixels = new Uint8Array(side * side * 4).fill(255);
    let seed = 1;
    for (let index = 0; index < pixels.length; index += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      // Opaque noise does not compress, so a 512-pixel PNG of it exceeds the limit.
      pixels[index] = index % 4 === 3 ? 255 : seed >> 16;
    }
    const { prepare } = await avatarFixture("avatars/noise.png", encodePngRgba(pixels, side, side));
    await using prepared = await prepare();
    await using extracted = await extractBuiltTemplateArtifact(prepared.artifact);
    const icon = await readFile(join(extracted.packageRoot, "assets/icon.png"));

    expect(icon.byteLength).toBeLessThanOrEqual(512 * 1024);
    expect(readImageProbeFromHeader(icon)).toMatchObject({ format: "png", width: 384 });
  });

  it("publishes re-encoded pixels without the source file's metadata", async () => {
    const text = Buffer.from("tEXtComment\0PRIVATE_METADATA_SENTINEL");
    const chunk = Buffer.alloc(text.length + 8);
    chunk.writeUInt32BE(text.length - 4, 0);
    text.copy(chunk, 4);
    chunk.writeUInt32BE(crc32(text), chunk.length - 4);
    // Insert the text chunk before the 12-byte IEND chunk.
    const source = Buffer.concat([PNG.subarray(0, -12), chunk, PNG.subarray(-12)]);
    const { prepare } = await avatarFixture("avatars/harbor.png", source);
    await using prepared = await prepare();
    await using extracted = await extractBuiltTemplateArtifact(prepared.artifact);
    const icon = await readFile(join(extracted.packageRoot, "assets/icon.png"));

    expect(source.includes("PRIVATE_METADATA_SENTINEL")).toBe(true);
    expect(readImageProbeFromHeader(icon)).toMatchObject({ format: "png", width: 1, height: 1 });
    expect(icon.includes("PRIVATE_METADATA_SENTINEL")).toBe(false);
  });

  it("removes the icon and both manifest references when the avatar is excluded", async () => {
    // An excluded avatar is never read, so even an unusable file cannot block the review.
    const { target } = await avatarFixture("avatars/harbor.png", "not an image");
    await using prepared = await prepareTemplateDraft({
      ...target,
      choices: { name: proposal.name, description: "", excluded: ["file:assets/icon.png"] },
    });

    expect(prepared.items).toEqual([
      expect.objectContaining({ id: "file:assets/icon.png", included: false }),
    ]);
    expect(prepared.files.map((file) => file.path)).toEqual(["CLAW.md", "package.json"]);
    expect(prepared).not.toHaveProperty("iconUrl");
    const manifest = manifestOf(prepared);
    expect(manifest).toMatchObject({ ok: true, value: { workspace: { files: [] } } });
    expect(JSON.stringify(manifest)).not.toMatch(/avatar|icon/u);
  });

  it("never packages a workspace image the draft does not name", async () => {
    const { prepare } = await avatarFixture(undefined);
    const withImage = await avatarFixture(undefined);
    await mkdir(join(withImage.workspaceDir, "avatars"));
    await writeFile(join(withImage.workspaceDir, "avatars/harbor.png"), PNG);
    await using plain = await prepare();
    await using prepared = await withImage.prepare();

    expect(prepared).not.toHaveProperty("iconUrl");
    expect(prepared.items).toEqual([]);
    expect(prepared.files).toEqual(plain.files);
    expect(prepared.integrity).toBe(plain.integrity);
  });

  it.each([
    { name: "a missing file", path: "avatars/missing.png", problem: "not a readable regular file" },
    {
      name: "text named as an image",
      path: "avatars/notes.png",
      bytes: "private notes",
      problem: "does not contain a PNG image",
    },
    {
      name: "an image whose bytes contradict its extension",
      path: "avatars/harbor.jpg",
      bytes: PNG,
      problem: "does not contain a JPG image",
    },
    {
      name: "an undecodable image",
      path: "avatars/harbor.png",
      bytes: PNG.subarray(0, 40),
      problem: "could not be decoded",
    },
    {
      name: "an oversized image",
      path: "avatars/huge.png",
      bytes: Buffer.concat([PNG, Buffer.alloc(AVATAR_MAX_BYTES)]),
      problem: "is larger than 2 MB",
    },
    {
      name: "an SVG that loads other content",
      path: "avatars/harbor.svg",
      bytes: SVG.replace("<rect", '<image href="https://example.test/a.png"/><rect'),
      problem: "not a self-contained SVG",
    },
    { name: "an unsupported type", path: "avatars/harbor.bmp", bytes: PNG, problem: "image path" },
    { name: "a traversing path", path: "../harbor.png", problem: "image path" },
    { name: "an absolute path", path: "/tmp/harbor.png", problem: "image path" },
  ])("fails review with an actionable error for $name", async ({ path, bytes, problem }) => {
    const { prepare } = await avatarFixture(path, path.startsWith("avatars/") ? bytes : undefined);
    await expect(prepare()).rejects.toMatchObject({
      name: "TemplateProjectError",
      code: "invalid_draft_avatar",
      message: expect.stringMatching(new RegExp(`${problem}.*or remove the field`, "u")),
    });
  });

  it.each(["symlink", "hardlink"] as const)("refuses an avatar that is a %s", async (kind) => {
    const { workspaceDir, prepare } = await avatarFixture("avatars/harbor.png");
    const outside = join(tempDirs.make("template-draft-avatar-source-"), "portrait.png");
    await writeFile(outside, PNG);
    await mkdir(join(workspaceDir, "avatars"));
    await (kind === "symlink" ? symlink : link)(outside, join(workspaceDir, "avatars/harbor.png"));
    await expect(prepare()).rejects.toMatchObject({
      code: "invalid_draft_avatar",
      message: expect.stringContaining("not a readable regular file"),
    });
  });

  it("refuses a draft that also declares an avatar in its manifest", async () => {
    const fixture = await draftFixture({
      ...proposal,
      avatar: "avatars/harbor.png",
      manifest: proposal.manifest.replace(
        "id: research-brief\n",
        "id: research-brief\n  identity: { avatar: 'data:image/png;base64,AAAA' }\n",
      ),
    });
    await expect(fixture.prepare()).rejects.toMatchObject({
      code: "invalid_draft_avatar",
      message: expect.stringContaining("agent.identity.avatar both declare"),
    });
  });

  it("rejects a draft whose avatar is not a path string", async () => {
    const { prepare } = await draftFixture({ ...proposal, avatar: { path: "avatars/harbor.png" } });
    await expect(prepare()).rejects.toMatchObject({ code: "invalid_draft" });
  });
});
