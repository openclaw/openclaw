import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tempWorkspace } from "@openclaw/fs-safe/temp";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { stringify } from "yaml";
import {
  type TemplateDraftDocument,
  type TemplateDraftReviewChoices,
  type TemplateDraftReviewItem,
  validateTemplateDraftDocument,
} from "../../packages/gateway-protocol/src/index.js";
import { root as fsSafeRoot } from "../infra/fs-safe.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { redactSensitiveText } from "../logging/redact.js";
import { TEMPLATE_BOOTSTRAP_FILE_NAMES } from "./manifest-contract.js";
import { buildTemplateProject, extractBuiltTemplateArtifact } from "./project-build.js";
import { TemplateProjectError } from "./project.js";
import { parseTemplateMarkdown } from "./reader.js";
import {
  isExactSemVer,
  isSafeTemplateRelativePath,
  portableTemplatePathKey,
} from "./schema-portability.js";
import { parseTemplateManifest } from "./schema.js";
import { parseTemplateYaml } from "./yaml-document.js";

export const MAX_TEMPLATE_DRAFT_BYTES = 1_000_000;
const DRAFT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

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
      "The draft must contain a name, semantic version, scope, CLAW.md manifest, and text files.",
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

function profileWithoutExcludedPlugins(content: string, refs: ReadonlySet<string>) {
  if (refs.size === 0) {
    return content;
  }
  const parsed = parseTemplateYaml(content, "profiles/openclaw.yml", "profile");
  if (!parsed.ok || !isRecord(parsed.value)) {
    return content;
  }
  const profile = parsed.value;
  if (!Array.isArray(profile.extensions)) {
    return content;
  }
  profile.extensions = profile.extensions.filter(
    (extension) =>
      !isRecord(extension) || typeof extension.ref !== "string" || !refs.has(extension.ref),
  );
  return stringify(profile);
}

/** Build a disposable, immutable publication snapshot from authored text only. */
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
    "profiles/openclaw.yml",
    "BOOTSTRAP.md",
    "LICENSE",
  ]);
  for (const file of authored.files) {
    if (sourcePaths.has(file.path)) {
      add({ id: `file:${file.path}`, kind: "file", label: file.path, detail: file.content });
    }
  }
  for (const pkg of draftManifest.packages) {
    add({
      id: `package:${pkg.kind}:${pkg.ref}`,
      kind: pkg.kind === "skill" ? "skill" : "plugin",
      label: pkg.ref,
      detail: `${pkg.source} · ${pkg.version}`,
    });
  }
  for (const [name, server] of Object.entries(draftManifest.mcpServers)) {
    add({ id: `mcp:${name}`, kind: "mcp", label: name, detail: JSON.stringify(server, null, 2) });
  }
  for (const job of draftManifest.cronJobs) {
    add({
      id: `cron:${job.id}`,
      kind: "automation",
      label: job.name ?? job.id,
      detail: `${job.schedule.cron} · ${job.schedule.timezone}`,
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
  const displayName =
    choices?.displayName ?? titleCaseTemplateName(draftManifest.agent.name ?? draftName);
  const description =
    choices?.description ?? authored.description ?? draftManifest.agent.description ?? "";
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
  draftManifest.packages = draftManifest.packages.filter(
    (pkg) => !excluded.has(`package:${pkg.kind}:${pkg.ref}`),
  );
  for (const key of Object.keys(draftManifest.mcpServers)) {
    if (excluded.has(`mcp:${key}`)) {
      delete draftManifest.mcpServers[key];
    }
  }
  draftManifest.cronJobs = draftManifest.cronJobs.filter((job) => !excluded.has(`cron:${job.id}`));
  const removedPluginRefs = new Set(
    items.filter((item) => item.kind === "plugin" && !item.included).map((item) => item.label),
  );
  const selectedFiles = [];
  for (const file of authored.files) {
    if (excluded.has(`file:${file.path}`)) {
      continue;
    }
    selectedFiles.push(
      file.path === "profiles/openclaw.yml"
        ? { ...file, content: profileWithoutExcludedPlugins(file.content, removedPluginRefs) }
        : file,
    );
  }
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
  const files = [
    {
      path: "package.json",
      content: `${JSON.stringify({ name, version: proposal.version, openclaw: { template: "CLAW.md" } }, null, 2)}\n`,
    },
    { path: "CLAW.md", content: manifest },
    ...proposal.files,
  ];
  const names = new Set<string>();
  for (const file of files) {
    assertPortableContent(file.path, file.content);
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
    const publishedFiles: Array<{ path: string; content: string }> = [];
    for (const path of built.files) {
      const read = await archiveRoot.read(path, {
        maxBytes: MAX_TEMPLATE_DRAFT_BYTES,
        symlinks: "reject",
        hardlinks: "reject",
      });
      const content = new TextDecoder("utf-8", { fatal: true }).decode(read.buffer);
      assertPortableContent(path, content);
      publishedFiles.push({ path, content });
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
      [Symbol.asyncDispose]: () => staging[Symbol.asyncDispose](),
    };
  } catch (error) {
    await staging[Symbol.asyncDispose]();
    throw error;
  }
}
