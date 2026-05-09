import fs from "node:fs/promises";
import path from "node:path";
import type { SecurityAuditFinding } from "./audit.types.js";
import { stripCommentsForHeuristics } from "./skill-scanner.js";

type SkillMarkdownSensitiveParameter = {
  line: number;
  evidence: string;
};

type SkillNetworkSendContext = {
  file: string;
  line: number;
  evidence: string;
};

const SCANNABLE_SKILL_SOURCE_EXTENSIONS = new Set([
  ".js",
  ".ts",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".jsx",
  ".tsx",
]);
const SKILL_MARKDOWN_SENSITIVE_PARAMETER_PATTERN =
  /\b(?:api[_-]?key|apikey|auth(?:orization)?|bearer|credential|credentials|cookie|oauth|passphrase|password|passwd|private[_-]?key|process\.env|secret|session[_ -]?cookie|token)\b/i;
const SKILL_MARKDOWN_PARAMETER_LINE_PATTERN =
  /^(?:[-*+]\s+|\d+[.)]\s+)?(?:`[^`]{1,80}`|[A-Za-z][A-Za-z0-9_.-]{0,79})\s*(?::|-)\s+\S/;
const SKILL_NETWORK_SEND_PATTERN =
  /\bfetch\s*\(|\b(?:http|https)\.request\s*\(|\b(?:axios|got|ky)\s*\(|\.\s*(?:post|put|patch|request)\s*\(|new\s+WebSocket\s*\(/i;
const MAX_SKILL_MARKDOWN_CONTEXT_ROWS = 4;
const MAX_SKILL_NETWORK_CONTEXT_ROWS = 4;
const MAX_SKILL_CONTEXT_SCAN_FILES = 500;
const MAX_SKILL_CONTEXT_FILE_BYTES = 1024 * 1024;

function isScannableSkillSourceFile(filePath: string): boolean {
  return SCANNABLE_SKILL_SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = line
    .trim()
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isLikelySkillParameterLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith("|")) {
    return !isMarkdownTableSeparator(trimmed) && trimmed.split("|").filter(Boolean).length >= 2;
  }
  return SKILL_MARKDOWN_PARAMETER_LINE_PATTERN.test(trimmed);
}

function collectSensitiveSkillMarkdownParameters(
  markdown: string,
): SkillMarkdownSensitiveParameter[] {
  const findings: SkillMarkdownSensitiveParameter[] = [];
  const lines = markdown.split(/\r?\n/);
  let inFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (/^(?:```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    if (!SKILL_MARKDOWN_SENSITIVE_PARAMETER_PATTERN.test(line)) {
      continue;
    }
    if (!isLikelySkillParameterLine(line)) {
      continue;
    }
    findings.push({
      line: index + 1,
      evidence: trimmed.slice(0, 180),
    });
  }

  return findings;
}

async function readTextFileWithinLimit(filePath: string): Promise<string | null> {
  const st = await fs.stat(filePath).catch(() => null);
  if (!st?.isFile() || st.size > MAX_SKILL_CONTEXT_FILE_BYTES) {
    return null;
  }
  return await fs.readFile(filePath, "utf-8").catch(() => null);
}

async function collectScannableSkillFilesForContext(skillDir: string): Promise<string[]> {
  const files: string[] = [];
  const stack: string[] = [skillDir];

  while (stack.length > 0 && files.length < MAX_SKILL_CONTEXT_SCAN_FILES) {
    const dir = stack.pop();
    if (!dir) {
      break;
    }
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= MAX_SKILL_CONTEXT_SCAN_FILES) {
        break;
      }
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && isScannableSkillSourceFile(entry.name)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

async function collectSkillNetworkSendContext(
  skillDir: string,
): Promise<SkillNetworkSendContext[]> {
  const files = await collectScannableSkillFilesForContext(skillDir);
  const contexts: SkillNetworkSendContext[] = [];

  for (const filePath of files) {
    const source = await readTextFileWithinLimit(filePath);
    if (source === null) {
      continue;
    }
    const heuristicSource = stripCommentsForHeuristics(source);
    const lines = source.split(/\r?\n/);
    const heuristicLines = heuristicSource.split(/\r?\n/);
    for (let index = 0; index < heuristicLines.length; index += 1) {
      const heuristicLine = heuristicLines[index] ?? "";
      if (!SKILL_NETWORK_SEND_PATTERN.test(heuristicLine)) {
        continue;
      }
      const line = lines[index] ?? heuristicLine;
      contexts.push({
        file: filePath,
        line: index + 1,
        evidence: line.trim().slice(0, 180),
      });
      break;
    }
    if (contexts.length >= MAX_SKILL_NETWORK_CONTEXT_ROWS) {
      break;
    }
  }

  return contexts;
}

function formatSkillContextPath(skillDir: string, filePath: string): string {
  const relPath = path.relative(skillDir, filePath);
  const displayPath =
    relPath && relPath !== "." && !relPath.startsWith("..") ? relPath : path.basename(filePath);
  return displayPath.replaceAll("\\", "/");
}

export async function collectSkillMarkdownSensitiveNetworkFinding(params: {
  skillDir: string;
  skillFilePath: string;
  skillName: string;
}): Promise<SecurityAuditFinding | null> {
  const markdown = await readTextFileWithinLimit(params.skillFilePath);
  if (markdown === null) {
    return null;
  }

  const sensitiveParameters = collectSensitiveSkillMarkdownParameters(markdown);
  if (sensitiveParameters.length === 0) {
    return null;
  }

  const networkContexts = await collectSkillNetworkSendContext(params.skillDir);
  if (networkContexts.length === 0) {
    return null;
  }

  const sensitiveDetails = sensitiveParameters
    .slice(0, MAX_SKILL_MARKDOWN_CONTEXT_ROWS)
    .map((entry) => `  - SKILL.md:${entry.line} ${entry.evidence}`)
    .join("\n");
  const networkDetails = networkContexts
    .slice(0, MAX_SKILL_NETWORK_CONTEXT_ROWS)
    .map(
      (entry) =>
        `  - ${formatSkillContextPath(params.skillDir, entry.file)}:${entry.line} ` +
        entry.evidence,
    )
    .join("\n");

  return {
    checkId: "skills.markdown_sensitive_network",
    severity: "critical",
    title: `Skill "${params.skillName}" combines sensitive SKILL.md parameters with outbound network code`,
    detail:
      "SKILL.md describes sensitive values in ordinary model-facing parameters while skill code performs outbound network I/O.\n" +
      `Sensitive parameter lines:\n${sensitiveDetails}\n` +
      `Outbound network code:\n${networkDetails}`,
    remediation:
      "Do not ask the model or user to pass credentials, tokens, cookies, or process.env through ordinary skill arguments. Move required secrets to OpenClaw-managed env/SecretRef configuration, remove the outbound send, or route the behavior through a reviewed plugin/tool boundary.",
  };
}
