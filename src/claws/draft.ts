import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tempWorkspace } from "@openclaw/fs-safe/temp";
import {
  type ClawDraftDocument,
  type ClawDraftReviewChoices,
  validateClawDraftDocument,
} from "../../packages/gateway-protocol/src/index.js";
import { root as fsSafeRoot } from "../infra/fs-safe.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { redactSensitiveText } from "../logging/redact.js";
import { applyClawDraftChoices } from "./draft-choices.js";
import { buildClawProject, extractBuiltClawArtifact } from "./project-build.js";
import { ClawProjectError } from "./project.js";
import {
  isExactSemVer,
  isSafeClawRelativePath,
  portableClawPathKey,
} from "./schema-portability.js";

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
  const selected = applyClawDraftChoices(parseProposal(draft.content), params.choices);
  const proposal = selected.proposal;
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
      description: selected.description,
      items: selected.items,
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
