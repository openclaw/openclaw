import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { stringify } from "yaml";
import type {
  ClawDraftDocument,
  ClawDraftReviewChoices,
  ClawDraftReviewItem,
} from "../../packages/gateway-protocol/src/index.js";
import { CLAW_BOOTSTRAP_FILE_NAMES } from "./manifest-contract.js";
import { ClawProjectError } from "./project.js";
import { parseClawMarkdown } from "./reader.js";
import { parseClawManifest } from "./schema.js";
import { parseClawYaml } from "./yaml-document.js";

function manifestFromDraft(markdown: string) {
  const parsed = parseClawMarkdown(Buffer.from(markdown), "CLAW.md");
  const manifest = parsed.ok ? parseClawManifest(parsed.value) : null;
  if (!parsed.ok || !manifest?.ok) {
    throw new ClawProjectError("invalid_draft", "Fix the Claw manifest before reviewing it.");
  }
  return { manifest: manifest.manifest, body: parsed.body.toString("utf8") };
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

/** Turn review choices into the sole input for the existing deterministic package builder. */
export function applyClawDraftChoices(
  proposal: ClawDraftDocument,
  choices?: ClawDraftReviewChoices,
): { proposal: ClawDraftDocument; description: string; items: ClawDraftReviewItem[] } {
  const { manifest, body } = manifestFromDraft(proposal.manifest);
  const excluded = new Set(choices?.excluded ?? []);
  const items: ClawDraftReviewItem[] = [];
  const add = (item: Omit<ClawDraftReviewItem, "included">) => {
    items.push({ ...item, included: !excluded.has(item.id) });
  };
  const sourcePaths = new Set([
    ...manifest.workspace.files.map((entry) => entry.source),
    ...Object.values(manifest.workspace.bootstrapFiles).flatMap((entry) =>
      entry ? [entry.source] : [],
    ),
    "profiles/openclaw.yml",
    "BOOTSTRAP.md",
    "LICENSE",
  ]);
  for (const file of proposal.files) {
    if (sourcePaths.has(file.path)) {
      add({ id: `file:${file.path}`, kind: "file", label: file.path, detail: file.content });
    }
  }
  for (const pkg of manifest.packages) {
    add({
      id: `package:${pkg.kind}:${pkg.ref}`,
      kind: pkg.kind === "skill" ? "skill" : "plugin",
      label: pkg.ref,
      detail: `${pkg.source} · ${pkg.version}`,
    });
  }
  for (const [name, server] of Object.entries(manifest.mcpServers)) {
    add({ id: `mcp:${name}`, kind: "mcp", label: name, detail: JSON.stringify(server, null, 2) });
  }
  for (const job of manifest.cronJobs) {
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
  const name = choices?.name ?? proposal.name;
  const description =
    choices?.description ?? proposal.description ?? manifest.agent.description ?? "";
  manifest.agent.id = name;
  manifest.agent.name = name;
  manifest.agent.description = description || undefined;
  manifest.workspace.files = manifest.workspace.files.filter(
    (entry) => !excluded.has(`file:${entry.source}`),
  );
  for (const target of CLAW_BOOTSTRAP_FILE_NAMES) {
    const entry = manifest.workspace.bootstrapFiles[target];
    if (entry && excluded.has(`file:${entry.source}`)) {
      delete manifest.workspace.bootstrapFiles[target];
    }
  }
  manifest.packages = manifest.packages.filter(
    (pkg) => !excluded.has(`package:${pkg.kind}:${pkg.ref}`),
  );
  for (const key of Object.keys(manifest.mcpServers)) {
    if (excluded.has(`mcp:${key}`)) {
      delete manifest.mcpServers[key];
    }
  }
  manifest.cronJobs = manifest.cronJobs.filter((job) => !excluded.has(`cron:${job.id}`));
  const removedPluginRefs = new Set(
    items.filter((item) => item.kind === "plugin" && !item.included).map((item) => item.label),
  );
  const files = [];
  for (const file of proposal.files) {
    if (excluded.has(`file:${file.path}`)) {
      continue;
    }
    files.push(
      file.path === "profiles/openclaw.yml"
        ? { ...file, content: profileWithoutExcludedPlugins(file.content, removedPluginRefs) }
        : file,
    );
  }
  return {
    proposal: {
      ...proposal,
      name,
      description,
      manifest: `---\n${stringify(manifest).trimEnd()}\n---\n${body}`,
      files,
    },
    description,
    items,
  };
}
