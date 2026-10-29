// Automatic skill diet: in auto mode, the daily Workshop maintenance pass shrinks one
// oversized learned skill. Branch-only sections move verbatim into references/, the
// rest is tightened, and a separate reviewer must confirm that no rule was lost or weakened
// before one versioned write publishes the result.
import path from "node:path";
import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import {
  asNonArrayRecord,
  asOptionalRecord,
  isStringArray,
} from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString, readStringValue } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { WorkshopChange } from "./changes.kernel.js";
import { resolveSkillWorkshopConfig } from "./config.js";
import {
  listSkillFiles,
  listWorkshopSkills,
  mutateSkill,
  publishSkillOverlay,
  readSkillFile,
  SKILL_FILE,
  validateSkillFile,
  viewWorkshopSkill,
  WorkshopWriteError,
} from "./library.js";
import { MAX_BODY_BYTES } from "./skill-lint.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";

const log = createSubsystemLogger("skills/workshop");

/** A diet must cut SKILL.md to at most this share of its size, or the rewrite is not worth its risk. */
const MAX_SIZE_RATIO = 0.8;
const DAY_MS = 24 * 60 * 60_000;
const COMPLETION_TIMEOUT_MS = 5 * 60_000;
const ANSWER_TOKEN_BUDGET = 16_384;
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;
const REFERENCE_PATH = /^references\/[a-z0-9][a-z0-9-]{0,62}\.md$/;
const MARKDOWN_LINK = /\]\(([^)\s]+)\)/g;
const EXTERNAL_LINK = /^(?:[a-z][a-z0-9+.-]*:|#|\/)/i;
// Titled inline links and reference-style definitions are not re-pointed when text moves.
const UNMOVABLE_LINK = /\]\([^)\s]+\s+["'(]|^ {0,3}\[[^\]]+\]:\s*\S/m;

export type SkillDietComplete = (request: {
  systemPrompt: string;
  prompt: string;
}) => Promise<string>;

type Section = { heading: string; text: string };
type ReferencePlan = { file: string; title: string; readWhen: string; sections: string[] };
type Candidate = { skillMd: string; references: Map<string, string> };
type AuditFinding = { rule: string; problem: string; detail: string };

class SkillDietRejected extends Error {
  override name = "SkillDietRejected";
}

const kib = (text: string) => (Buffer.byteLength(text) / 1024).toFixed(1);

/** Lines of a markdown text, each marked when it is a fence line or inside fenced code. */
function* markdownLines(text: string): Generator<{ line: string; fenced: boolean }> {
  let fence: string | undefined;
  for (const line of text.split("\n")) {
    const marker = /^\s*(```|~~~)/.exec(line)?.[1];
    if (marker) {
      fence = fence === undefined ? marker : fence === marker ? undefined : fence;
    }
    yield { line, fenced: marker !== undefined || fence !== undefined };
  }
}

/** Splits a body at top-level `## ` headings, ignoring headings inside fenced code. */
function splitSkillSections(body: string): Section[] {
  const sections: Section[] = [];
  let current: { heading: string; lines: string[] } | undefined;
  const flush = () => {
    if (current) {
      sections.push({ heading: current.heading, text: current.lines.join("\n").trimEnd() });
    }
  };
  for (const { line, fenced } of markdownLines(body)) {
    const heading = fenced ? undefined : /^## (.+?)\s*$/.exec(line)?.[1];
    if (heading !== undefined) {
      flush();
      current = { heading, lines: [line] };
    } else {
      current?.lines.push(line);
    }
  }
  flush();
  return sections;
}

/** Re-points relative links in text moved from the skill root into `references/`. */
function relinkForReferences(text: string): string {
  return text.replace(MARKDOWN_LINK, (match, target: string) => {
    if (EXTERNAL_LINK.test(target)) {
      return match;
    }
    const [file = "", anchor] = target.split("#", 2);
    const moved = path.posix.relative("references", path.posix.normalize(file));
    return `](${moved}${anchor === undefined ? "" : `#${anchor}`})`;
  });
}

/** Absolute targets of the relative links in one file of the skill. */
function linkTargets(skillDir: string, filePath: string, text: string): string[] {
  return [...text.matchAll(MARKDOWN_LINK)]
    .map((match) => match[1] ?? "")
    .filter((target) => !EXTERNAL_LINK.test(target))
    .map((target) =>
      path.resolve(
        skillDir,
        path.posix.dirname(filePath),
        decodeLinkPart(target.split("#", 1)[0] ?? ""),
      ),
    );
}

function decodeLinkPart(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** GitHub-style anchors of a markdown file's headings; repeated headings get -1, -2, … */
function headingAnchors(text: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const { line, fenced } of markdownLines(text)) {
    const heading = fenced ? undefined : /^#{1,6}\s+(.+?)\s*$/.exec(line)?.[1];
    if (heading === undefined) {
      continue;
    }
    const slug = heading
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return anchors;
}

function parseJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const value =
    start >= 0 && end > start
      ? asOptionalRecord(safeParseJson(text.slice(start, end + 1)))
      : undefined;
  if (!value) {
    throw new SkillDietRejected("model reply was not a JSON object");
  }
  return value;
}

function requireText(record: Record<string, unknown>, key: string): string {
  const value = readNonBlankString(record[key]);
  if (value === undefined) {
    throw new SkillDietRejected(`model reply is missing "${key}"`);
  }
  return value;
}

function parsePlan(text: string): { skill: string; references: ReferencePlan[] } {
  const reply = parseJsonObject(text);
  const references = Array.isArray(reply.references) ? reply.references : [];
  return {
    skill: requireText(reply, "skill"),
    references: references.map((entry: unknown) => {
      const record = asNonArrayRecord(entry);
      const sections = record.sections;
      if (!isStringArray(sections)) {
        throw new SkillDietRejected("model reply has a reference without section headings");
      }
      return {
        file: requireText(record, "file"),
        title: requireText(record, "title"),
        readWhen: requireText(record, "readWhen"),
        sections,
      };
    }),
  };
}

function parseAudit(text: string): AuditFinding[] {
  const findings = parseJsonObject(text).findings;
  if (!Array.isArray(findings)) {
    throw new SkillDietRejected("reviewer reply is missing findings");
  }
  return findings.map((finding: unknown) => {
    const record = asNonArrayRecord(finding);
    // A finding still counts when the reviewer returns a field in another JSON shape.
    const [rule, problem, detail] = [record.rule, record.problem, record.detail].map(
      (value) => readStringValue(value) ?? JSON.stringify(value ?? ""),
    );
    return { rule: rule ?? "", problem: problem ?? "", detail: detail ?? "" };
  });
}

/**
 * Builds the next skill from a plan and checks everything that needs no model: moved sections
 * are copied verbatim, every link resolves, every new reference is linked from SKILL.md, the
 * result is materially smaller, and each file passes the normal Workshop validation.
 */
function buildCandidate(params: {
  config: OpenClawConfig;
  name: string;
  skillDir: string;
  liveFiles: readonly string[];
  /** Existing support Markdown files, which may link into SKILL.md headings. */
  liveReferences: ReadonlyArray<readonly [string, string]>;
  frontmatter: string;
  liveSkillMd: string;
  sections: readonly Section[];
  skill: string;
  references: readonly ReferencePlan[];
}): Candidate {
  const skillMd = `${params.frontmatter}\n${params.skill.trim()}\n`;
  const references = new Map<string, string>();
  const moved = new Set<string>();
  for (const reference of params.references) {
    if (!REFERENCE_PATH.test(reference.file)) {
      throw new SkillDietRejected(`reference path ${reference.file} is not references/<name>.md`);
    }
    if (params.liveFiles.includes(reference.file) || references.has(reference.file)) {
      throw new SkillDietRejected(`reference ${reference.file} already exists`);
    }
    const parts = reference.sections.map((named) => {
      // Models sometimes repeat the heading marks; the heading text names the section.
      const heading = named.replace(/^#+\s*/, "").trim();
      const section = params.sections.find((entry) => entry.heading === heading);
      if (!section || moved.has(heading)) {
        throw new SkillDietRejected(`section "${heading}" is unknown or moved twice`);
      }
      // An in-page link's target depends on the file it sits in; moving it could silently retarget it.
      if (section.text.includes("](#")) {
        throw new SkillDietRejected(`section "${heading}" has in-page links and cannot move`);
      }
      moved.add(heading);
      return relinkForReferences(section.text);
    });
    if (parts.length === 0) {
      throw new SkillDietRejected(`reference ${reference.file} moves no sections`);
    }
    references.set(
      reference.file,
      `# ${reference.title.trim()}\n\n${reference.readWhen.trim()}\n\n${parts.join("\n\n")}\n`,
    );
  }
  if (
    moved.size > 0 &&
    (UNMOVABLE_LINK.test(params.liveSkillMd.slice(params.frontmatter.length)) ||
      params.liveReferences.some(([, content]) => UNMOVABLE_LINK.test(content)))
  ) {
    throw new SkillDietRejected(
      "the skill uses titled or reference-style links, which a move cannot re-point",
    );
  }
  if (splitSkillSections(params.skill).some((section) => moved.has(section.heading))) {
    throw new SkillDietRejected("a moved section is still in SKILL.md");
  }
  if (Buffer.byteLength(skillMd) > Buffer.byteLength(params.liveSkillMd) * MAX_SIZE_RATIO) {
    throw new SkillDietRejected(
      `SKILL.md would shrink only ${kib(params.liveSkillMd)} → ${kib(skillMd)} KB`,
    );
  }
  // Links into the skill must hit a file of the next skill; links out of it must already exist
  // in the live SKILL.md, so a rewrite cannot invent a path.
  const inside = (target: string) => target.startsWith(params.skillDir + path.sep);
  const bundle = new Set(
    [...params.liveFiles, ...references.keys()].map((file) => path.resolve(params.skillDir, file)),
  );
  const liveOutside = new Set(
    linkTargets(params.skillDir, SKILL_FILE, params.liveSkillMd).filter(
      (target) => !inside(target),
    ),
  );
  const files: Array<[string, string]> = [[SKILL_FILE, skillMd], ...references];
  for (const [file, content] of files) {
    for (const target of linkTargets(params.skillDir, file, content)) {
      if (!(inside(target) ? bundle.has(target) : liveOutside.has(target))) {
        throw new SkillDietRejected(`${file} links to ${target}, which does not resolve`);
      }
    }
  }
  // Every anchor into a Markdown file of the next skill (SKILL.md, a new reference, or an
  // existing one), from any file of the skill, must land on a heading of that file. A skill
  // whose links were already broken is left undieted.
  const anchorsAt = new Map(
    [...params.liveReferences, ...files].map(([file, content]) => [
      path.resolve(params.skillDir, file),
      headingAnchors(content),
    ]),
  );
  for (const [file, content] of [...files, ...params.liveReferences]) {
    for (const [, target = ""] of content.matchAll(MARKDOWN_LINK)) {
      const [linked = "", fragment] = target.split("#", 2);
      if (!fragment || /^[a-z][a-z0-9+.-]*:|^\//i.test(linked)) {
        continue;
      }
      const anchor = decodeLinkPart(fragment);
      const destination = path.resolve(
        params.skillDir,
        path.posix.dirname(file),
        linked ? decodeLinkPart(linked) : path.posix.basename(file),
      );
      if (anchorsAt.get(destination)?.has(anchor) === false) {
        throw new SkillDietRejected(`${file} links to ${target}, which does not resolve`);
      }
    }
  }
  const fromSkill = new Set(linkTargets(params.skillDir, SKILL_FILE, skillMd));
  for (const file of references.keys()) {
    if (!fromSkill.has(path.resolve(params.skillDir, file))) {
      throw new SkillDietRejected(`SKILL.md does not link ${file}`);
    }
  }
  for (const [file, content] of files) {
    validateSkillFile(params.config, params.name, file, content);
  }
  return { skillMd, references };
}

const DIET_RULES = [
  "You shrink an agent's learned skill (a SKILL.md procedure). Every run that uses the skill reads all of SKILL.md; a file under references/ is read only when SKILL.md points to it for the case at hand. The goal is fewer tokens per run with no change in behavior.",
  "Rules:",
  "- Keep in SKILL.md only what most runs need: when to use the skill, the ordered core steps with their checks, and safety rules that apply to every run (credentials and secrets, destructive or irreversible actions, provider or tool substitution, weakening guards).",
  "- Move every other whole `## ` section into new reference files, grouping related sections into the same file. Name sections by exact heading; the system copies them verbatim.",
  "- A moved section's rules travel with it. Do not restate, summarize, or condense them anywhere in SKILL.md; its lookup line is how the agent finds them.",
  "- Tighten what stays: drop words, repetition, and explanation that do not change what the agent does. Keep every rule's force: words like only, exact, supported, before, unless, never; every condition, fallback, and order; every command, flag, path, field name, and link. When unsure, keep the wording.",
  "- Add no new rules, steps, or claims.",
  "- End SKILL.md with a `## Look up the case` list: one line per new reference, `- <situations that need it> → [<file name>](references/<file>.md)`. Keep every existing link.",
  "- The system keeps the frontmatter; return only the body.",
].join("\n");

const PLAN_OUTPUT = [
  "Reply with JSON only:",
  '{"skill": "<new SKILL.md body without frontmatter>", "references": [{"file": "references/<kebab-name>.md", "title": "<title>", "readWhen": "<one sentence: when to read this file>", "sections": ["<exact heading>"]}]}',
  "Use 1-4 new reference files, or none if no section is branch-only.",
].join("\n");

const REPAIR_OUTPUT =
  'A reviewer found problems in your rewrite. Restore each missing or weakened rule in SKILL.md with its original force, and remove each added rule. The reference files are fixed. Reply with JSON only: {"skill": "<revised SKILL.md body without frontmatter>"}';

const AUDIT_SYSTEM = [
  "You are a strict reviewer of a rewritten agent skill. BEFORE is the original SKILL.md. AFTER is the rewrite: its SKILL.md plus new reference files that SKILL.md links. Existing reference files are unchanged and not shown.",
  "For every distinct instruction, condition, check, fallback, and prohibition in BEFORE, confirm AFTER still carries it with the same force and the same reach. The agent reads SKILL.md on every run but a reference only in the situations its lookup line names, so a rule that applies to every run must stay in SKILL.md, and a moved rule's lookup line must cover every situation where the rule applied in BEFORE. A rule that is present but no longer reached when it applies is weakened. Report a rule as missing when AFTER drops it, and as weakened when it becomes softer, narrower, broader in what it permits, or loses a condition, qualifier (such as supported, only, exact), order, or fallback. Report as added any instruction, step, condition, default, or claim in AFTER that BEFORE does not contain; the `## Look up the case` index and each reference's title and read-when line are not additions. Ignore pure rewording.",
  'Reply with JSON only: {"findings": [{"rule": "<the rule>", "problem": "missing, weakened, or added", "detail": "<what changed>"}]}. An empty list means AFTER carries exactly the rules of BEFORE.',
].join("\n");

function renderAfter(candidate: Candidate): string {
  return [
    `===== SKILL.md =====\n${candidate.skillMd}`,
    ...[...candidate.references].map(([file, content]) => `===== ${file} =====\n${content}`),
  ].join("\n\n");
}

async function audit(
  complete: SkillDietComplete,
  liveSkillMd: string,
  candidate: Candidate,
): Promise<AuditFinding[]> {
  return parseAudit(
    await complete({
      systemPrompt: AUDIT_SYSTEM,
      prompt: `######## BEFORE\n${liveSkillMd}\n\n######## AFTER\n${renderAfter(candidate)}`,
    }),
  );
}

/** The skill's Markdown support files with their contents, in listing order. */
async function readSupportMarkdown(
  skillDir: string,
  files: readonly string[],
): Promise<Array<[string, string]>> {
  const markdown: Array<[string, string]> = [];
  for (const file of files.filter((entry) => entry !== SKILL_FILE && entry.endsWith(".md"))) {
    markdown.push([file, (await readSkillFile(skillDir, file)) ?? ""]);
  }
  return markdown;
}

/**
 * Writes the next skill in one versioned change. The candidate was validated against the live
 * file list, SKILL.md and Markdown support files; any change to them meanwhile refuses the diet.
 */
async function publishDiet(params: {
  config: OpenClawConfig;
  agentId: string;
  name: string;
  liveFiles: readonly string[];
  liveSkillMd: string;
  liveReferences: ReadonlyArray<readonly [string, string]>;
  candidate: Candidate;
  summary: string;
  assertLive: () => void;
}): Promise<WorkshopChange> {
  const { config, agentId, assertLive, candidate } = params;
  const files: Array<[string, string]> = [[SKILL_FILE, candidate.skillMd], ...candidate.references];
  return await mutateSkill(
    { config, agentId, actor: "curator", assertLive },
    params.name,
    "write_file",
    async (paths) => {
      const { files: currentFiles } = await listSkillFiles(paths.skillDir);
      if (
        currentFiles.join("\n") !== params.liveFiles.join("\n") ||
        (await readSkillFile(paths.skillDir, SKILL_FILE)) !== params.liveSkillMd ||
        JSON.stringify(await readSupportMarkdown(paths.skillDir, currentFiles)) !==
          JSON.stringify(params.liveReferences)
      ) {
        throw new WorkshopWriteError(`Skill "${params.name}" changed during its diet.`);
      }
      const versionId = await publishSkillOverlay(paths, files);
      return { summary: params.summary, ...(versionId ? { versionId } : {}) };
    },
  );
}

/** Diets one learned skill. Returns the change, or undefined when the diet was not safe to apply. */
export async function dietWorkshopSkill(params: {
  config: OpenClawConfig;
  agentId: string;
  name: string;
  complete: SkillDietComplete;
  assertLive: () => void;
}): Promise<WorkshopChange | undefined> {
  const { config, agentId, name, complete } = params;
  const live = await viewWorkshopSkill(config, agentId, name);
  const liveSkillMd = live.content;
  const frontmatter = FRONTMATTER.exec(liveSkillMd)?.[0];
  const skillDir = path.join(resolveWorkshopSkillsDir(config, agentId), name);
  if (!frontmatter) {
    return undefined;
  }
  const sections = splitSkillSections(liveSkillMd.slice(frontmatter.length));
  const liveReferences = await readSupportMarkdown(skillDir, live.files);
  const build = (skill: string, references: readonly ReferencePlan[]) =>
    buildCandidate({
      config,
      name,
      skillDir,
      liveFiles: live.files,
      liveReferences,
      frontmatter,
      liveSkillMd,
      sections,
      skill,
      references,
    });
  try {
    const plan = parsePlan(
      await complete({
        systemPrompt: `${DIET_RULES}\n\n${PLAN_OUTPUT}`,
        prompt: `Skill "${name}". Existing files: ${live.files.join(", ")}.\n\n${liveSkillMd}`,
      }),
    );
    let candidate = build(plan.skill, plan.references);
    let findings = await audit(complete, liveSkillMd, candidate);
    if (findings.length > 0) {
      // One repair pass: the findings go back to the writer; the moved sections stay fixed.
      const repaired = parseJsonObject(
        await complete({
          systemPrompt: `${DIET_RULES}\n\n${REPAIR_OUTPUT}`,
          prompt: `######## ORIGINAL\n${liveSkillMd}\n\n######## YOUR REWRITE\n${renderAfter(candidate)}\n\n######## FINDINGS\n${JSON.stringify(findings, null, 2)}`,
        }),
      );
      candidate = build(requireText(repaired, "skill"), plan.references);
      findings = await audit(complete, liveSkillMd, candidate);
    }
    if (findings.length > 0) {
      // The findings quote skill text, which stays out of Gateway logs.
      throw new SkillDietRejected(`reviewer still found ${findings.length} problem(s)`);
    }
    const moved = plan.references.reduce(
      (count, reference) => count + reference.sections.length,
      0,
    );
    const summary =
      `diet: SKILL.md ${kib(liveSkillMd)} → ${kib(candidate.skillMd)} KB` +
      (candidate.references.size > 0
        ? `; moved ${moved} section(s) to ${[...candidate.references.keys()].join(", ")}`
        : "");
    return await publishDiet({
      ...params,
      liveFiles: live.files,
      liveSkillMd,
      liveReferences,
      candidate,
      summary,
    });
  } catch (error) {
    if (!(error instanceof SkillDietRejected) && !(error instanceof WorkshopWriteError)) {
      throw error;
    }
    log.info(`skill diet skipped: skill=${name} ${formatErrorMessage(error)}`);
    return undefined;
  }
}

/**
 * Picks today's skill: oversized skills that have not changed for a day, in name order, rotated
 * by calendar day. The rotation needs no stored state and keeps a skill that cannot be dieted
 * from blocking the rest: it costs one attempt every N days, where N is the number of oversized
 * skills.
 */
export async function selectSkillForDiet(
  config: OpenClawConfig,
  agentId: string,
  nowMs: number,
): Promise<string | undefined> {
  const root = resolveWorkshopSkillsDir(config, agentId);
  const oversized: string[] = [];
  for (const skill of await listWorkshopSkills(config, agentId)) {
    // A skill edited within the last day may be mid-use or mid-lesson; leave it to settle.
    if (skill.updatedAtMs > nowMs - DAY_MS) {
      continue;
    }
    const content = (await readSkillFile(path.join(root, skill.name), SKILL_FILE)) ?? "";
    if (Buffer.byteLength(content.replace(FRONTMATTER, "")) > MAX_BODY_BYTES) {
      oversized.push(skill.name);
    }
  }
  oversized.sort((a, b) => a.localeCompare(b));
  return oversized[Math.floor(nowMs / DAY_MS) % oversized.length];
}

/** One diet model call on the agent's primary model: no tools, no transcript. */
async function createSkillDietCompletion(
  config: OpenClawConfig,
  agentId: string,
  abortSignal: AbortSignal,
  assertLive: () => void,
): Promise<SkillDietComplete> {
  const { prepareUtilityCompletionForAgent, runUtilityCompletion } =
    await import("../../agents/utility-completion.js");
  const prepared = await prepareUtilityCompletionForAgent({ cfg: config, agentId });
  return async ({ systemPrompt, prompt }) =>
    (
      await runUtilityCompletion({
        ...prepared,
        purpose: "skill-diet",
        config,
        systemPrompt,
        prompt,
        thinkLevel: "medium",
        timeoutMs: COMPLETION_TIMEOUT_MS,
        abortSignal,
        assertCurrent: assertLive,
        answerTokenBudget: ANSWER_TOKEN_BUDGET,
      })
    ).text;
}

/** Diets at most one skill for the agent; part of the daily auto-mode maintenance pass. */
export async function runWorkshopSkillDiet(params: {
  config: OpenClawConfig;
  agentId: string;
  nowMs: number;
  abortSignal: AbortSignal;
  complete?: SkillDietComplete;
}): Promise<WorkshopChange | undefined> {
  const { config, agentId } = params;
  const name = await selectSkillForDiet(config, agentId, params.nowMs);
  if (!name) {
    return undefined;
  }
  // The pass was admitted under the turn's config; the operator may have left auto mode since.
  const assertLive = () => {
    if (resolveSkillWorkshopConfig(getRuntimeConfig()).autonomous.mode !== "auto") {
      throw new WorkshopWriteError("Learning is no longer in auto mode.");
    }
  };
  assertLive();
  const complete =
    params.complete ??
    (await createSkillDietCompletion(config, agentId, params.abortSignal, assertLive));
  return await dietWorkshopSkill({
    config,
    agentId,
    name,
    complete: async (request) => {
      assertLive();
      return await complete(request);
    },
    assertLive,
  });
}
