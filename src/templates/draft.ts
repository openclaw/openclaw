import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { tempWorkspace } from "@openclaw/fs-safe/temp";
import { stringify } from "yaml";
import {
  type TemplateDraftDocument,
  type TemplateDraftReviewChoices,
  type TemplateDraftReviewItem,
  type TemplatesDraftsReviewResult,
  validateTemplateDraftDocument,
} from "../../packages/gateway-protocol/src/index.js";
import { isSelfContainedSvg } from "../../packages/gateway-protocol/src/svg-image.js";
import { FsSafeError, root as fsSafeRoot } from "../infra/fs-safe.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { redactSensitiveText } from "../logging/redact.js";
import {
  isImageProcessorUnavailableError,
  optimizeImageToPng,
  readImageProbeFromHeader,
} from "../media/image-ops.js";
import { PORTABLE_PLUGIN_ICON_PATH } from "../plugins/portable-icon-paths.js";
import { AVATAR_MAX_BYTES, isSupportedLocalAvatarExtension } from "../shared/avatar-policy.js";
import { templateDependencyInventory } from "./dependency-inventory.js";
import { TEMPLATE_BOOTSTRAP_FILE_NAMES } from "./manifest-contract.js";
import { buildTemplateProject, extractBuiltTemplateArtifact } from "./project-build.js";
import { TemplateProjectError } from "./project.js";
import { parseTemplateMarkdown } from "./reader.js";
import {
  isExactSemVer,
  isSafeTemplateRelativePath,
  portableTemplatePathKey,
} from "./schema-portability.js";
import { parseTemplateManifest, type TemplateManifest } from "./schema.js";

export const MAX_TEMPLATE_DRAFT_BYTES = 1_000_000;
const DRAFT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/** ClawHub reads a package's listing icon only from `assets/icon.png`, as a PNG of at most 512 KiB. */
const TEMPLATE_ICON_MAX_BYTES = 512 * 1024;
const TEMPLATE_ICON_SIDES = [512, 384, 256, 192, 128];
/** Where Add writes the packaged avatar in the new agent's workspace. */
const TEMPLATE_AVATAR_WORKSPACE_PATH = "avatars/avatar.png";
const TEMPLATE_AVATAR_ITEM_ID = `file:${PORTABLE_PLUGIN_ICON_PATH}`;
const RASTER_AVATAR_FORMATS: Record<string, string> = {
  ".png": "png",
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".gif": "gif",
  ".webp": "webp",
};

export function templateDraftRevision(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function templateDraftRelativePath(draftId: string): string {
  if (!DRAFT_ID.test(draftId)) {
    throw new TemplateProjectError("invalid_draft_id", "Invalid Template draft id.");
  }
  return `.openclaw/template-drafts/${draftId}.json`;
}

/** The agent edits a private proposal. No source workspace files are copied. */
export async function createTemplateDraft(workspaceDir: string, assertCurrent?: () => void) {
  const draftId = randomUUID();
  const relativePath = templateDraftRelativePath(draftId);
  const document: TemplateDraftDocument = {
    name: "my-template",
    description: "",
    version: "0.1.0",
    scope: { input: "", job: "", output: "", authority: "" },
    manifest: "---\nschemaVersion: 1\nagent:\n  id: my-template\n---\n",
    files: [],
  };
  const root = await fsSafeRoot(workspaceDir);
  assertCurrent?.();
  await root.write(relativePath, `${JSON.stringify(document, null, 2)}\n`, {
    mkdir: true,
    overwrite: false,
    mode: 0o600,
    assertBeforeMutation: assertCurrent,
  });
  return { draftId, path: join(workspaceDir, relativePath) };
}

export async function readTemplateDraft(workspaceDir: string, draftId: string) {
  const root = await fsSafeRoot(workspaceDir);
  const result = await root.read(templateDraftRelativePath(draftId), {
    maxBytes: MAX_TEMPLATE_DRAFT_BYTES,
    symlinks: "reject",
    hardlinks: "reject",
  });
  const content = new TextDecoder("utf-8", { fatal: true }).decode(result.buffer);
  return { content, revision: templateDraftRevision(content) };
}

function assertPortableContent(path: string, content: string) {
  const segments = portableTemplatePathKey(path).split("/");
  if (
    !isSafeTemplateRelativePath(path) ||
    path.includes("\\") ||
    segments.some((part) =>
      /^(?:\.env(?:\..*)?|\.git|\.openclaw|memory(?:\.md)?|user\.md|sessions?|transcripts?|credentials?|auth-profiles\.json|secrets?)$/.test(
        part,
      ),
    ) ||
    portableTemplatePathKey(path).endsWith(".jsonl")
  ) {
    throw new TemplateProjectError(
      "private_draft_file",
      `Remove private or unsafe file ${JSON.stringify(path)} from the proposal.`,
    );
  }
  if (content.includes("\0") || redactSensitiveText(content, { mode: "tools" }) !== content) {
    throw new TemplateProjectError(
      "sensitive_draft_content",
      `Remove credential-like content from ${JSON.stringify(path)} before reviewing.`,
    );
  }
}

function parseProposal(content: string): TemplateDraftDocument {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new TemplateProjectError(
      "invalid_draft",
      "The draft must be valid JSON. Save or finish the agent's draft before reviewing.",
    );
  }
  if (!validateTemplateDraftDocument(value) || !isExactSemVer(value.version)) {
    throw new TemplateProjectError(
      "invalid_draft",
      "The draft must contain a name, semantic version, scope, CLAW.md manifest, and text files. An avatar, when present, must be a workspace-relative image path.",
    );
  }
  if (Object.values(value.scope).some((item) => !item.trim())) {
    throw new TemplateProjectError(
      "incomplete_draft",
      "Describe the input, job, output, and authority boundary before reviewing.",
    );
  }
  return value;
}

/**
 * Read the one image a draft may name and re-encode it as the package icon.
 * Only decoded pixels are published, so the workspace file's metadata stays private.
 */
async function readDraftAvatarIcon(workspaceDir: string, path: string): Promise<Buffer> {
  const invalid = (problem: string) =>
    new TemplateProjectError(
      "invalid_draft_avatar",
      `The draft avatar ${JSON.stringify(path)} ${problem} Point "avatar" at a PNG, JPEG, GIF, WebP, or SVG file in this agent's workspace, or remove the field.`,
    );
  const extension = extname(path).toLowerCase();
  if (
    !isSafeTemplateRelativePath(path) ||
    path.includes("\\") ||
    !isSupportedLocalAvatarExtension(path)
  ) {
    throw invalid("is not a workspace-relative image path.");
  }
  let source: Buffer;
  try {
    const root = await fsSafeRoot(workspaceDir);
    const read = await root.read(path, {
      maxBytes: AVATAR_MAX_BYTES,
      symlinks: "reject",
      hardlinks: "reject",
    });
    source = read.buffer;
  } catch (error) {
    throw invalid(
      error instanceof FsSafeError && error.code === "too-large"
        ? `is larger than ${AVATAR_MAX_BYTES / (1024 * 1024)} MB.`
        : "is not a readable regular file in this agent's workspace.",
    );
  }
  let image = source;
  if (extension === ".svg") {
    let svg: string;
    try {
      svg = new TextDecoder("utf-8", { fatal: true }).decode(source);
    } catch {
      throw invalid("is not an SVG image.");
    }
    if (!isSelfContainedSvg(svg)) {
      throw invalid("is not a self-contained SVG image.");
    }
    try {
      // Accepted edge: a pathological SVG rasterizes on the Gateway thread. The file is the
      // administrator's own bounded workspace avatar, and a slow review is visible and recoverable.
      const { Resvg } = await import("@resvg/resvg-js");
      const font = { loadSystemFonts: false };
      const { width, height } = new Resvg(svg, { font });
      image = new Resvg(svg, {
        font,
        fitTo: { mode: width >= height ? "width" : "height", value: TEMPLATE_ICON_SIDES[0]! },
      })
        .render()
        .asPng();
    } catch {
      throw invalid("could not be rendered as an SVG image.");
    }
  } else if (readImageProbeFromHeader(source)?.format !== RASTER_AVATAR_FORMATS[extension]) {
    throw invalid(`does not contain a ${extension.slice(1).toUpperCase()} image.`);
  }
  try {
    return (
      await optimizeImageToPng(image, TEMPLATE_ICON_MAX_BYTES, { sides: TEMPLATE_ICON_SIDES })
    ).buffer;
  } catch (error) {
    if (isImageProcessorUnavailableError(error)) {
      throw error;
    }
    throw invalid("could not be decoded as an image.");
  }
}

function manifestFromDraft(markdown: string) {
  const parsed = parseTemplateMarkdown(Buffer.from(markdown), "CLAW.md");
  const manifest = parsed.ok ? parseTemplateManifest(parsed.value) : null;
  if (!parsed.ok || !manifest?.ok) {
    throw new TemplateProjectError(
      "invalid_draft",
      "Fix the Template manifest before reviewing it.",
    );
  }
  return { manifest: manifest.manifest, body: parsed.body.toString("utf8") };
}

function titleCaseTemplateName(value: string) {
  return value
    .replace(/[-_]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .map((word) => word.replace(/^(\p{L})/u, (letter) => letter.toUpperCase()))
    .join(" ");
}

function packageReviewId(kind: "skill" | "plugin", pkg: TemplateManifest["skills"][number]) {
  return "path" in pkg
    ? `package:${kind}:bundled:${pkg.path}`
    : `package:${kind}:clawhub:${pkg.ref}`;
}

/** Build a disposable, immutable publication snapshot from authored text and one optional avatar. */
export async function prepareTemplateDraft(params: {
  workspaceDir: string;
  draftId: string;
  publisher: string;
  choices?: TemplateDraftReviewChoices;
}) {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(params.publisher)) {
    throw new TemplateProjectError(
      "invalid_publisher",
      "ClawHub did not return a valid personal publisher handle.",
    );
  }
  const draft = await readTemplateDraft(params.workspaceDir, params.draftId);
  const authored = parseProposal(draft.content);
  const choices = params.choices;
  const { manifest: draftManifest, body } = manifestFromDraft(authored.manifest);
  const excluded = new Set(choices?.excluded ?? []);
  const items: TemplateDraftReviewItem[] = [];
  const add = (item: Omit<TemplateDraftReviewItem, "included">) => {
    items.push({ ...item, included: !excluded.has(item.id) });
  };
  const sourcePaths = new Set([
    ...draftManifest.workspace.files.map((entry) => entry.source),
    ...Object.values(draftManifest.workspace.bootstrapFiles).flatMap((entry) =>
      entry ? [entry.source] : [],
    ),
    "BOOTSTRAP.md",
    "LICENSE",
  ]);
  for (const file of authored.files) {
    if (sourcePaths.has(file.path)) {
      add({ id: `file:${file.path}`, kind: "file", label: file.path, detail: file.content });
    }
  }
  if (authored.avatar !== undefined) {
    // Without this, the manifest's own avatar would be replaced silently.
    if (draftManifest.agent.identity?.avatar) {
      throw new TemplateProjectError(
        "invalid_draft_avatar",
        "The draft's \"avatar\" field and the manifest's agent.identity.avatar both declare the agent avatar. Remove one of them.",
      );
    }
    add({
      id: TEMPLATE_AVATAR_ITEM_ID,
      kind: "file",
      label: PORTABLE_PLUGIN_ICON_PATH,
      detail: authored.avatar,
    });
  }
  for (const pkg of templateDependencyInventory(draftManifest)) {
    add({
      id: packageReviewId(pkg.kind, pkg),
      kind: pkg.kind === "skill" ? "skill" : "plugin",
      label: pkg.source === "bundled" ? pkg.path : pkg.ref,
      detail: pkg.source === "bundled" ? "bundled folder" : `${pkg.source} · ${pkg.version}`,
      requirement:
        pkg.source === "bundled"
          ? { source: pkg.source, path: pkg.path }
          : { source: pkg.source, ref: pkg.ref, version: pkg.version },
    });
  }
  for (const [name, server] of Object.entries(draftManifest.mcpServers)) {
    add({ id: `mcp:${name}`, kind: "mcp", label: name, detail: JSON.stringify(server, null, 2) });
  }
  for (const job of draftManifest.automations) {
    add({
      id: `cron:${job.id}`,
      kind: "automation",
      label: job.name ?? job.id,
      detail: `${job.schedule.cron} · ${job.schedule.timezone} · ${job.enabled === false ? "Disabled" : "Enabled"}`,
      automation: {
        message: job.message,
        schedule: job.schedule,
        session: job.session,
        enabled: job.enabled !== false,
      },
    });
  }
  const known = new Set(items.map((item) => item.id));
  if (
    excluded.size !== (choices?.excluded.length ?? 0) ||
    [...excluded].some((id) => !known.has(id))
  ) {
    throw new TemplateProjectError(
      "invalid_review_choices",
      "Reload the Template review before changing its selections.",
    );
  }
  const draftName = choices?.name ?? authored.name;
  // Only the slug-derived default is title-cased; a CLAW.md agent name is the author's text.
  const displayName =
    choices?.displayName?.trim() || draftManifest.agent.name || titleCaseTemplateName(draftName);
  // New drafts start with `description: ""`; that must not erase the CLAW.md description.
  const description = (
    choices?.description ??
    (authored.description || draftManifest.agent.description) ??
    ""
  ).trim();
  draftManifest.agent.id = draftName;
  draftManifest.agent.name = displayName;
  draftManifest.agent.description = description || undefined;
  draftManifest.workspace.files = draftManifest.workspace.files.filter(
    (entry) => !excluded.has(`file:${entry.source}`),
  );
  for (const target of TEMPLATE_BOOTSTRAP_FILE_NAMES) {
    const entry = draftManifest.workspace.bootstrapFiles[target];
    if (entry && excluded.has(`file:${entry.source}`)) {
      delete draftManifest.workspace.bootstrapFiles[target];
    }
  }
  draftManifest.skills = draftManifest.skills.filter(
    (pkg) => !excluded.has(packageReviewId("skill", pkg)),
  );
  draftManifest.plugins = draftManifest.plugins.filter(
    (pkg) => !excluded.has(packageReviewId("plugin", pkg)),
  );
  for (const key of Object.keys(draftManifest.mcpServers)) {
    if (excluded.has(`mcp:${key}`)) {
      delete draftManifest.mcpServers[key];
    }
  }
  draftManifest.automations = draftManifest.automations.filter(
    (job) => !excluded.has(`cron:${job.id}`),
  );
  // One reviewed image is both the ClawHub listing icon and the new agent's avatar, so
  // excluding it removes the file and both manifest references together.
  const icon =
    authored.avatar !== undefined && !excluded.has(TEMPLATE_AVATAR_ITEM_ID)
      ? await readDraftAvatarIcon(params.workspaceDir, authored.avatar)
      : undefined;
  if (icon) {
    draftManifest.workspace.files.push({
      source: PORTABLE_PLUGIN_ICON_PATH,
      path: TEMPLATE_AVATAR_WORKSPACE_PATH,
    });
    draftManifest.agent.identity = {
      ...draftManifest.agent.identity,
      avatar: TEMPLATE_AVATAR_WORKSPACE_PATH,
    };
  }
  const excludedBundles = templateDependencyInventory(
    manifestFromDraft(authored.manifest).manifest,
  ).filter((pkg) => pkg.source === "bundled" && excluded.has(packageReviewId(pkg.kind, pkg)));
  const retainedWorkspaceSources = new Set([
    ...draftManifest.workspace.files.map((file) => file.source),
    ...Object.values(draftManifest.workspace.bootstrapFiles).flatMap((file) =>
      file ? [file.source] : [],
    ),
  ]);
  const selectedFiles = authored.files.filter(
    (file) =>
      !excluded.has(`file:${file.path}`) &&
      (retainedWorkspaceSources.has(file.path) ||
        !excludedBundles.some(
          (pkg) => pkg.source === "bundled" && file.path.startsWith(`${pkg.path}/`),
        )),
  );
  const proposal = {
    ...authored,
    name: draftName,
    description,
    manifest: `---\n${stringify(draftManifest).trimEnd()}\n---\n${body}`,
    files: selectedFiles,
  };
  const name = `@${params.publisher}/${proposal.name}`;
  const manifest = `${proposal.manifest.trimEnd()}\n\n## Portable workflow\n\n${Object.entries(
    proposal.scope,
  )
    .map(([key, value]) => `### ${key.charAt(0).toUpperCase()}${key.slice(1)}\n\n${value.trim()}`)
    .join("\n\n")}\n`;
  const files: Array<{ path: string; content: string | Buffer }> = [
    {
      path: "package.json",
      content: `${JSON.stringify({ name, version: proposal.version, openclaw: { template: "CLAW.md" } }, null, 2)}\n`,
    },
    { path: "CLAW.md", content: manifest },
    ...proposal.files,
    ...(icon ? [{ path: PORTABLE_PLUGIN_ICON_PATH, content: icon }] : []),
  ];
  const names = new Set<string>();
  for (const file of files) {
    if (typeof file.content === "string") {
      assertPortableContent(file.path, file.content);
    }
    const key = portableTemplatePathKey(file.path);
    if (names.has(key)) {
      throw new TemplateProjectError(
        "duplicate_draft_file",
        `Duplicate draft file ${JSON.stringify(file.path)}.`,
      );
    }
    names.add(key);
  }
  const staging = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "template-draft-",
    dirMode: 0o700,
    mode: 0o600,
  });
  try {
    const project = staging.path("project");
    await mkdir(project, { mode: 0o700 });
    const root = await fsSafeRoot(project);
    for (const file of files) {
      await root.create(file.path, file.content, { mkdir: true, mode: 0o600 });
    }
    const built = await buildTemplateProject(project, staging.path("template.tgz"));
    await using extracted = await extractBuiltTemplateArtifact(built.artifact);
    const archiveRoot = await fsSafeRoot(extracted.packageRoot);
    const workspaceFiles = [
      ...Object.entries(draftManifest.workspace.bootstrapFiles).flatMap(([path, entry]) =>
        entry ? [{ path, source: entry.source }] : [],
      ),
      ...draftManifest.workspace.files,
    ];
    const publishedFiles: TemplatesDraftsReviewResult["files"] = [];
    for (const path of built.files) {
      const workspacePaths = workspaceFiles
        .filter((file) => file.source === path)
        .map((file) => file.path);
      if (path === "BOOTSTRAP.md") {
        workspacePaths.push(path);
      }
      const mapped = workspacePaths.length ? { workspacePaths } : {};
      // The icon is the archive's only binary file; the review shows it through iconUrl.
      if (icon && path === PORTABLE_PLUGIN_ICON_PATH) {
        publishedFiles.push({ path, ...mapped });
        continue;
      }
      const read = await archiveRoot.read(path, {
        maxBytes: MAX_TEMPLATE_DRAFT_BYTES,
        symlinks: "reject",
        hardlinks: "reject",
      });
      const content = new TextDecoder("utf-8", { fatal: true }).decode(read.buffer);
      assertPortableContent(path, content);
      publishedFiles.push({ path, content, ...mapped });
    }
    return {
      name,
      version: proposal.version,
      scope: proposal.scope,
      description,
      displayName,
      items,
      revision: draft.revision,
      integrity: built.integrity,
      artifact: built.artifact,
      files: publishedFiles,
      ...(icon ? { iconUrl: `data:image/png;base64,${icon.toString("base64")}` } : {}),
      [Symbol.asyncDispose]: () => staging[Symbol.asyncDispose](),
    };
  } catch (error) {
    await staging[Symbol.asyncDispose]();
    throw error;
  }
}
