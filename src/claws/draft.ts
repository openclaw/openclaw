import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tempWorkspace } from "@openclaw/fs-safe/temp";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { stringify } from "yaml";
import {
  type ClawDraftDocument,
  type ClawDraftReviewChoices,
  type ClawDraftReviewItem,
  validateClawDraftDocument,
} from "../../packages/gateway-protocol/src/index.js";
import { root as fsSafeRoot } from "../infra/fs-safe.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { redactSensitiveText } from "../logging/redact.js";
import { CLAW_BOOTSTRAP_FILE_NAMES } from "./manifest-contract.js";
import { buildClawProject, extractBuiltClawArtifact } from "./project-build.js";
import { ClawProjectError } from "./project.js";
import { parseClawMarkdown } from "./reader.js";
import {
  isExactSemVer,
  isSafeClawRelativePath,
  portableClawPathKey,
} from "./schema-portability.js";
import { parseClawManifest } from "./schema.js";
import { parseClawYaml } from "./yaml-document.js";

export const MAX_CLAW_DRAFT_BYTES = 1_000_000;
const DRAFT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export function clawDraftRevision(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function clawDraftRelativePath(draftId: string): string {
  if (!DRAFT_ID.test(draftId)) {
    throw new ClawProjectError("invalid_draft_id", "Invalid Claw draft id.");
  }
  return `.openclaw/claw-drafts/${draftId}.json`;
}

/** The agent edits a private proposal. No source workspace files are copied. */
export async function createClawDraft(workspaceDir: string, assertCurrent?: () => void) {
  const draftId = randomUUID();
  const relativePath = clawDraftRelativePath(draftId);
  const document: ClawDraftDocument = {
    name: "my-claw",
    description: "",
    version: "0.1.0",
    scope: { input: "", job: "", output: "", authority: "" },
    manifest: "---\nschemaVersion: 1\nagent:\n  id: my-claw\n---\n",
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

export async function readClawDraft(workspaceDir: string, draftId: string) {
  const root = await fsSafeRoot(workspaceDir);
  const result = await root.read(clawDraftRelativePath(draftId), {
    maxBytes: MAX_CLAW_DRAFT_BYTES,
    symlinks: "reject",
    hardlinks: "reject",
  });
  const content = new TextDecoder("utf-8", { fatal: true }).decode(result.buffer);
  return { content, revision: clawDraftRevision(content) };
}

function assertPortableContent(path: string, content: string) {
  const segments = portableClawPathKey(path).split("/");
  if (
    !isSafeClawRelativePath(path) ||
    path.includes("\\") ||
    segments.some((part) =>
      /^(?:\.env(?:\..*)?|\.git|\.openclaw|memory(?:\.md)?|user\.md|sessions?|transcripts?|credentials?|auth-profiles\.json|secrets?)$/.test(
        part,
      ),
    ) ||
    portableClawPathKey(path).endsWith(".jsonl")
  ) {
    throw new ClawProjectError(
      "private_draft_file",
      `Remove private or unsafe file ${JSON.stringify(path)} from the proposal.`,
    );
  }
  if (content.includes("\0") || redactSensitiveText(content, { mode: "tools" }) !== content) {
    throw new ClawProjectError(
      "sensitive_draft_content",
      `Remove credential-like content from ${JSON.stringify(path)} before reviewing.`,
    );
  }
}

function parseProposal(content: string): ClawDraftDocument {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new ClawProjectError(
      "invalid_draft",
      "The draft must be valid JSON. Save or finish the agent's draft before reviewing.",
    );
  }
  if (!validateClawDraftDocument(value) || !isExactSemVer(value.version)) {
    throw new ClawProjectError(
      "invalid_draft",
      "The draft must contain a name, semantic version, scope, CLAW.md manifest, and text files.",
    );
  }
  if (Object.values(value.scope).some((item) => !item.trim())) {
    throw new ClawProjectError(
      "incomplete_draft",
      "Describe the input, job, output, and authority boundary before reviewing.",
    );
  }
  return value;
}

function manifestFromDraft(markdown: string) {
  const parsed = parseClawMarkdown(Buffer.from(markdown), "CLAW.md");
  const manifest = parsed.ok ? parseClawManifest(parsed.value) : null;
  if (!parsed.ok || !manifest?.ok) {
    throw new ClawProjectError("invalid_draft", "Fix the Claw manifest before reviewing it.");
  }
  return { manifest: manifest.manifest, body: parsed.body.toString("utf8") };
}

function titleCaseClawName(value: string) {
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
  const parsed = parseClawYaml(content, "profiles/openclaw.yml", "profile");
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
export async function prepareClawDraft(params: {
  workspaceDir: string;
  draftId: string;
  publisher: string;
  choices?: ClawDraftReviewChoices;
}) {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(params.publisher)) {
    throw new ClawProjectError(
      "invalid_publisher",
      "ClawHub did not return a valid personal publisher handle.",
    );
  }
  const draft = await readClawDraft(params.workspaceDir, params.draftId);
  const authored = parseProposal(draft.content);
  const choices = params.choices;
  const { manifest: draftManifest, body } = manifestFromDraft(authored.manifest);
  const excluded = new Set(choices?.excluded ?? []);
  const items: ClawDraftReviewItem[] = [];
  const add = (item: Omit<ClawDraftReviewItem, "included">) => {
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
    throw new ClawProjectError(
      "invalid_review_choices",
      "Reload the Claw review before changing its selections.",
    );
  }
  const draftName = choices?.name ?? authored.name;
  const displayName =
    choices?.displayName ?? titleCaseClawName(draftManifest.agent.name ?? draftName);
  const description =
    choices?.description ?? authored.description ?? draftManifest.agent.description ?? "";
  draftManifest.agent.id = draftName;
  draftManifest.agent.name = displayName;
  draftManifest.agent.description = description || undefined;
  draftManifest.workspace.files = draftManifest.workspace.files.filter(
    (entry) => !excluded.has(`file:${entry.source}`),
  );
  for (const target of CLAW_BOOTSTRAP_FILE_NAMES) {
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
      content: `${JSON.stringify({ name, version: proposal.version, openclaw: { claw: "CLAW.md" } }, null, 2)}\n`,
    },
    { path: "CLAW.md", content: manifest },
    ...proposal.files,
  ];
  const names = new Set<string>();
  for (const file of files) {
    assertPortableContent(file.path, file.content);
    const key = portableClawPathKey(file.path);
    if (names.has(key)) {
      throw new ClawProjectError(
        "duplicate_draft_file",
        `Duplicate draft file ${JSON.stringify(file.path)}.`,
      );
    }
    names.add(key);
  }
  const staging = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "claw-draft-",
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
    const built = await buildClawProject(project, staging.path("claw.tgz"));
    await using extracted = await extractBuiltClawArtifact(built.artifact);
    const archiveRoot = await fsSafeRoot(extracted.packageRoot);
    const publishedFiles: Array<{ path: string; content: string }> = [];
    for (const path of built.files) {
      const read = await archiveRoot.read(path, {
        maxBytes: MAX_CLAW_DRAFT_BYTES,
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
