import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { EmbeddedContextFile } from "./embedded-agent-helpers/context-file.js";

export const PERSONAL_USER_CONTEXT_INSTRUCTIONS =
  "The personal users/<profile-id>/USER.md belongs to this session's selected person (assigned human owner, otherwise human creator). It supplements shared USER.md and overrides conflicting shared preferences, not higher-priority rules. Other participants do not change this personal context.";

const CONTEXT_FILE_ORDER = new Map<string, number>([
  ["agents.md", 10],
  ["soul.md", 20],
  ["identity.md", 30],
  ["user.md", 40],
  ["tools.md", 50],
  ["bootstrap.md", 60],
  ["memory.md", 70],
]);

const DEFAULT_HEARTBEAT_PROMPT_CONTEXT_BLOCK =
  /Default heartbeat prompt:\r?\n`(?:Read HEARTBEAT\.md if it exists|Follow the heartbeat monitor scratch context when provided\.)[^`\r\n]*HEARTBEAT_OK\.`/gu;
function normalizeContextFilePath(pathValue: string): string {
  return pathValue.trim().replace(/\\/g, "/");
}

export function isBootstrapContextFile(pathValue: string): boolean {
  return /(^|[\\/])BOOTSTRAP\.md$/iu.test(pathValue.trim());
}

function sanitizeContextFileContentForPrompt(content: string): string {
  // Old workspace templates otherwise route Claude subscriptions to paid extra
  // usage; heartbeat behavior remains in the actual scheduled user turn.
  return content.replaceAll(DEFAULT_HEARTBEAT_PROMPT_CONTEXT_BLOCK, "").replace(/\n{3,}/g, "\n\n");
}

export function prepareContextFilesForPrompt<T extends EmbeddedContextFile>(
  contextFiles: readonly T[],
  options: {
    order?: ReadonlyMap<string, number>;
    caseInsensitivePathOrder?: boolean;
    trimBasename?: boolean;
  } = {},
) {
  return contextFiles
    .map((file) => {
      const path = normalizeContextFilePath(file.path);
      const rawBasename = path.slice(path.lastIndexOf("/") + 1);
      const basename =
        options.trimBasename === false
          ? rawBasename.toLowerCase()
          : normalizeLowercaseStringOrEmpty(rawBasename);
      return {
        file,
        path,
        basename,
        order: (options.order ?? CONTEXT_FILE_ORDER).get(basename) ?? Number.MAX_SAFE_INTEGER,
      };
    })
    .toSorted((a, b) => {
      if (a.order !== b.order) {
        return a.order - b.order;
      }
      if (a.basename !== b.basename) {
        return a.basename.localeCompare(b.basename);
      }
      // Preserve loader precedence for shared USER defaults and the personal overlay.
      if (a.basename === "user.md") {
        return 0;
      }
      return options.caseInsensitivePathOrder
        ? a.path.toLowerCase().localeCompare(b.path.toLowerCase())
        : a.path.localeCompare(b.path);
    });
}

export function buildProjectContextSection(files: ReturnType<typeof prepareContextFilesForPrompt>) {
  if (files.length === 0) {
    return [];
  }
  const lines = ["# Project Context", ""];
  const hasSoulFile = files.some((file) => file.basename === "soul.md");
  const hasMemoryFile = files.some((file) => file.basename === "memory.md");
  const hasUserFile = files.some((file) => file.basename === "user.md");
  lines.push("Loaded project context:");
  if (hasSoulFile) {
    lines.push("SOUL.md: persona/tone. Follow it unless higher-priority instructions override.");
  }
  if (hasMemoryFile) {
    lines.push(
      "MEMORY.md: durable non-profile facts and decisions; use when relevant unless higher-priority instructions override.",
    );
  }
  if (hasUserFile) {
    lines.push(
      "USER.md: durable user preferences and profile directives; follow unless higher-priority instructions override.",
    );
  }
  if (files.some(({ file }) => file.personalUser)) {
    lines.push(PERSONAL_USER_CONTEXT_INSTRUCTIONS);
  }
  lines.push("");
  for (const { file } of files) {
    lines.push(`## ${file.path}`, "", sanitizeContextFileContentForPrompt(file.content), "");
  }
  return lines;
}
