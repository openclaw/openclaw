import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { EmbeddedContextFile } from "./embedded-agent-helpers/context-file.js";
import { filterProjectScopedCuratedContextFiles } from "./project-memory-bootstrap.js";
import { sanitizeForPromptLiteral } from "./sanitize-for-prompt.js";

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
  // Old workspace templates otherwise route Claude subscriptions to paid extra usage.
  return content.replaceAll(DEFAULT_HEARTBEAT_PROMPT_CONTEXT_BLOCK, "").replace(/\n{3,}/g, "\n\n");
}

export function prepareContextFilesForPrompt<T extends EmbeddedContextFile>(
  contextFiles: readonly T[],
  options: {
    order?: ReadonlyMap<string, number>;
    caseInsensitivePathOrder?: boolean;
    trimBasename?: boolean;
    workspaceDir?: string;
    canonicalWorkspaceDir?: string;
  } = {},
) {
  const workspaceDir = options.workspaceDir
    ? normalizeContextFilePath(options.workspaceDir)
    : undefined;
  const canonicalDir = options.canonicalWorkspaceDir
    ? normalizeContextFilePath(options.canonicalWorkspaceDir)
    : undefined;
  const roots = [...new Set([workspaceDir, canonicalDir])]
    .filter((root) => root !== undefined)
    // Strip trailing separators so `/ws/` and `C:/` compare against `/ws` and `C:`; the
    // filesystem root keeps its empty-string identity for the root containment check below.
    .map((root) => root.replace(/\/+$/u, ""))
    .map((root, index, all) => (root === "" && all[index] === "/" ? "/" : root))
    .filter((root, _index, all) => root !== "" || !all.some((other) => other === "/"));
  return contextFiles
    .map((file) => {
      const path = normalizeContextFilePath(file.path);
      const rawBasename = path.slice(path.lastIndexOf("/") + 1);
      const basename =
        options.trimBasename === false
          ? rawBasename.toLowerCase()
          : normalizeLowercaseStringOrEmpty(rawBasename);
      let headingPath = path;
      for (const root of roots) {
        if (path === root) {
          headingPath = ".";
          break;
        }
        if (root === "" ? path.startsWith("/") : path.startsWith(`${root}/`)) {
          headingPath = root === "" ? path.slice(1) : path.slice(root.length + 1);
          break;
        }
      }
      let content = file.content;
      if (file.missing && roots.length > 0) {
        const fullMarker = `[MISSING] Expected at: ${headingPath}`;
        content =
          fullMarker.length <= content.length
            ? fullMarker
            : content.length <= 3
              ? fullMarker.slice(0, content.length)
              : `${fullMarker.slice(0, content.length - 1)}…`;
      }
      const effectiveFile = content === file.content ? file : { ...file, content };
      return {
        file: effectiveFile,
        path,
        basename,
        headingPath,
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
  lines.push("Loaded project context:");
  for (const [basename, guidance] of Object.entries({
    "soul.md": "SOUL.md: persona/tone. Follow it unless higher-priority instructions override.",
    "memory.md":
      "MEMORY.md: durable non-profile facts and decisions; use when relevant unless higher-priority instructions override.",
    "user.md":
      "USER.md: durable user preferences and profile directives; follow unless higher-priority instructions override.",
  })) {
    if (files.some((file) => file.basename === basename)) {
      lines.push(guidance);
    }
  }
  if (files.some(({ file }) => file.personalUser)) {
    lines.push(PERSONAL_USER_CONTEXT_INSTRUCTIONS);
  }
  lines.push("");
  for (const { file, headingPath } of files) {
    lines.push(`## ${headingPath}`, "", sanitizeContextFileContentForPrompt(file.content), "");
  }
  return lines;
}

export function projectStableContextFiles(files: ReturnType<typeof prepareContextFilesForPrompt>) {
  return files.map(({ headingPath, file }) => ({
    headingPath,
    personalUser: file.personalUser,
    contentHash: sha256Hex(file.content),
  }));
}

export function prepareSystemPromptContextFiles(params: {
  contextFiles?: EmbeddedContextFile[];
  activeProjectKeys?: readonly string[];
  workspaceDir?: string;
  canonicalWorkspaceDir?: string;
}) {
  const filtered = filterProjectScopedCuratedContextFiles({
    contextFiles: params.contextFiles,
    activeProjectKeys: params.activeProjectKeys,
  }).filter((file) => file.path.trim().length > 0);
  return prepareContextFilesForPrompt(filtered, {
    workspaceDir: params.workspaceDir,
    canonicalWorkspaceDir: params.canonicalWorkspaceDir
      ? sanitizeForPromptLiteral(params.canonicalWorkspaceDir)
      : undefined,
  });
}
