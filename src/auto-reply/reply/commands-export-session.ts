import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { SessionEntry as PiSessionEntry, SessionHeader } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { ReplyPayload } from "../types.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { resolveSessionAgentIds } from "../../agents/agent-scope.js";
import { resolveBootstrapContextForRun } from "../../agents/bootstrap-files.js";
import { resolveDefaultModelForAgent } from "../../agents/model-selection.js";
import { createOpenClawCodingTools } from "../../agents/pi-tools.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox.js";
import { buildWorkspaceSkillSnapshot } from "../../agents/skills.js";
import { getSkillsSnapshotVersion } from "../../agents/skills/refresh.js";
import { buildSystemPromptParams } from "../../agents/system-prompt-params.js";
import { buildAgentSystemPrompt } from "../../agents/system-prompt.js";
import { buildToolSummaryMap } from "../../agents/tool-summaries.js";
import {
  resolveDefaultSessionStorePath,
  resolveSessionFilePath,
} from "../../config/sessions/paths.js";
import { loadSessionStore } from "../../config/sessions/store.js";
import { getRemoteSkillEligibility } from "../../infra/skills-remote.js";
import { buildTtsSystemPromptHint } from "../../tts/tts.js";

// Find pi-coding-agent export-html templates by traversing node_modules
function findPiExportDir(): string {
  // Start from this file's directory and look for node_modules
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  let current = thisDir;
  while (current !== path.dirname(current)) {
    const candidate = path.join(
      current,
      "node_modules",
      "@mariozechner",
      "pi-coding-agent",
      "dist",
      "core",
      "export-html",
    );
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    current = path.dirname(current);
  }
  throw new Error("Could not find @mariozechner/pi-coding-agent export-html templates");
}

interface SessionData {
  header: SessionHeader | null;
  entries: PiSessionEntry[];
  leafId: string | null;
  systemPrompt?: string;
  tools?: Array<{ name: string; description?: string; parameters?: unknown }>;
}

let cachedExportDir: string | null = null;

function getExportDir(): string {
  if (!cachedExportDir) {
    cachedExportDir = findPiExportDir();
  }
  return cachedExportDir;
}

function loadTemplate(fileName: string): string {
  return fs.readFileSync(path.join(getExportDir(), fileName), "utf-8");
}

function generateHtml(sessionData: SessionData): string {
  const template = loadTemplate("template.html");
  const templateCss = loadTemplate("template.css");
  const templateJs = loadTemplate("template.js");
  const markedJs = loadTemplate(path.join("vendor", "marked.min.js"));
  const hljsJs = loadTemplate(path.join("vendor", "highlight.min.js"));

  // Use default theme colors
  const themeVars = `
    --bg: #1a1a2e;
    --fg: #eaeaea;
    --userMessageBg: #2d2d44;
    --assistantMessageBg: #1e1e30;
    --toolCallBg: #252538;
    --toolResultBg: #1c1c2c;
    --codeBg: #0d0d14;
    --borderColor: #3a3a5a;
    --linkColor: #6b9fff;
    --errorColor: #ff6b6b;
    --successColor: #6bff6b;
    --warningColor: #ffcc00;
  `;
  const bodyBg = "#1a1a2e";
  const containerBg = "#1e1e30";
  const infoBg = "#2a2a40";

  // Base64 encode session data
  const sessionDataBase64 = Buffer.from(JSON.stringify(sessionData)).toString("base64");

  // Build CSS with theme variables
  const css = templateCss
    .replace("{{THEME_VARS}}", themeVars)
    .replace("{{BODY_BG}}", bodyBg)
    .replace("{{CONTAINER_BG}}", containerBg)
    .replace("{{INFO_BG}}", infoBg);

  return template
    .replace("{{CSS}}", css)
    .replace("{{JS}}", templateJs)
    .replace("{{SESSION_DATA}}", sessionDataBase64)
    .replace("{{MARKED_JS}}", markedJs)
    .replace("{{HIGHLIGHT_JS}}", hljsJs);
}

async function resolveFullSystemPrompt(params: HandleCommandsParams): Promise<{
  systemPrompt: string;
  tools: AgentTool[];
}> {
  const workspaceDir = params.workspaceDir;
  const { contextFiles: injectedFiles } = await resolveBootstrapContextForRun({
    workspaceDir,
    config: params.cfg,
    sessionKey: params.sessionKey,
    sessionId: params.sessionEntry?.sessionId,
  });
  const skillsSnapshot = (() => {
    try {
      return buildWorkspaceSkillSnapshot(workspaceDir, {
        config: params.cfg,
        eligibility: { remote: getRemoteSkillEligibility() },
        snapshotVersion: getSkillsSnapshotVersion(workspaceDir),
      });
    } catch {
      return { prompt: "", skills: [], resolvedSkills: [] };
    }
  })();
  const skillsPrompt = skillsSnapshot.prompt ?? "";
  const sandboxRuntime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.ctx.SessionKey ?? params.sessionKey,
  });
  const tools = (() => {
    try {
      return createOpenClawCodingTools({
        config: params.cfg,
        workspaceDir,
        sessionKey: params.sessionKey,
        messageProvider: params.command.channel,
        groupId: params.sessionEntry?.groupId ?? undefined,
        groupChannel: params.sessionEntry?.groupChannel ?? undefined,
        groupSpace: params.sessionEntry?.space ?? undefined,
        spawnedBy: params.sessionEntry?.spawnedBy ?? undefined,
        senderIsOwner: params.command.senderIsOwner,
        modelProvider: params.provider,
        modelId: params.model,
      });
    } catch {
      return [];
    }
  })();
  const toolSummaries = buildToolSummaryMap(tools);
  const toolNames = tools.map((t) => t.name);
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.cfg,
  });
  const defaultModelRef = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: sessionAgentId,
  });
  const defaultModelLabel = `${defaultModelRef.provider}/${defaultModelRef.model}`;
  const { runtimeInfo, userTimezone, userTime, userTimeFormat } = buildSystemPromptParams({
    config: params.cfg,
    agentId: sessionAgentId,
    workspaceDir,
    cwd: process.cwd(),
    runtime: {
      host: "unknown",
      os: "unknown",
      arch: "unknown",
      node: process.version,
      model: `${params.provider}/${params.model}`,
      defaultModel: defaultModelLabel,
    },
  });
  const sandboxInfo = sandboxRuntime.sandboxed
    ? {
        enabled: true,
        workspaceDir,
        workspaceAccess: "rw" as const,
        elevated: {
          allowed: params.elevated.allowed,
          defaultLevel: (params.resolvedElevatedLevel ?? "off") as "on" | "off" | "ask" | "full",
        },
      }
    : { enabled: false };
  const ttsHint = params.cfg ? buildTtsSystemPromptHint(params.cfg) : undefined;

  const systemPrompt = buildAgentSystemPrompt({
    workspaceDir,
    defaultThinkLevel: params.resolvedThinkLevel,
    reasoningLevel: params.resolvedReasoningLevel,
    extraSystemPrompt: undefined,
    ownerNumbers: undefined,
    reasoningTagHint: false,
    toolNames,
    toolSummaries,
    modelAliasLines: [],
    userTimezone,
    userTime,
    userTimeFormat,
    contextFiles: injectedFiles,
    skillsPrompt,
    heartbeatPrompt: undefined,
    ttsHint,
    runtimeInfo,
    sandboxInfo,
    memoryCitationsMode: params.cfg?.memory?.citations,
  });

  return { systemPrompt, tools };
}

function parseExportArgs(commandBodyNormalized: string): { outputPath?: string; open?: boolean } {
  const normalized = commandBodyNormalized.trim();
  if (normalized === "/export-session" || normalized === "/export") {
    return {};
  }
  const args = normalized.replace(/^\/(export-session|export)\s*/, "").trim();
  const parts = args.split(/\s+/);
  let outputPath: string | undefined;
  let open = false;
  for (const part of parts) {
    if (part === "--open" || part === "-o") {
      open = true;
    } else if (!part.startsWith("-") && !outputPath) {
      outputPath = part;
    }
  }
  return { outputPath, open };
}

export async function buildExportSessionReply(params: HandleCommandsParams): Promise<ReplyPayload> {
  const args = parseExportArgs(params.command.commandBodyNormalized);

  // 1. Resolve session file
  const sessionEntry = params.sessionEntry as SessionEntry | undefined;
  if (!sessionEntry?.sessionId) {
    return { text: "❌ No active session found." };
  }

  const storePath = resolveDefaultSessionStorePath(params.agentId);
  const store = loadSessionStore(storePath, { skipCache: true });
  const entry = store[params.sessionKey] as SessionEntry | undefined;
  if (!entry?.sessionId) {
    return { text: `❌ Session not found: ${params.sessionKey}` };
  }

  let sessionFile: string;
  try {
    sessionFile = resolveSessionFilePath(entry.sessionId, entry, {
      agentId: params.agentId,
      sessionsDir: path.dirname(storePath),
    });
  } catch (err) {
    return {
      text: `❌ Failed to resolve session file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!fs.existsSync(sessionFile)) {
    return { text: `❌ Session file not found: ${sessionFile}` };
  }

  // 2. Load session entries
  const sessionManager = SessionManager.open(sessionFile);
  const entries = sessionManager.getEntries();
  const header = sessionManager.getHeader();
  const leafId = sessionManager.getLeafId();

  // 3. Build full system prompt
  const { systemPrompt, tools } = await resolveFullSystemPrompt(params);

  // 4. Prepare session data
  const sessionData: SessionData = {
    header,
    entries,
    leafId,
    systemPrompt,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  };

  // 5. Generate HTML
  const html = generateHtml(sessionData);

  // 6. Determine output path
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const defaultFileName = `openclaw-session-${entry.sessionId.slice(0, 8)}-${timestamp}.html`;
  const outputPath = args.outputPath
    ? path.resolve(args.outputPath.startsWith("~") ? args.outputPath.replace("~", process.env.HOME ?? "") : args.outputPath)
    : path.join(params.workspaceDir, defaultFileName);

  // Ensure directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // 7. Write file
  fs.writeFileSync(outputPath, html, "utf-8");

  // 8. Optionally open in browser
  if (args.open) {
    const { exec } = await import("node:child_process");
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    exec(`${cmd} "${outputPath}"`);
  }

  const relativePath = path.relative(params.workspaceDir, outputPath);
  const displayPath = relativePath.startsWith("..") ? outputPath : relativePath;

  return {
    text: [
      "✅ Session exported!",
      "",
      `📄 File: ${displayPath}`,
      `📊 Entries: ${entries.length}`,
      `🧠 System prompt: ${systemPrompt.length.toLocaleString()} chars`,
      `🔧 Tools: ${tools.length}`,
      "",
      args.open ? "🌐 Opening in browser..." : `Tip: /export-session --open to auto-open`,
    ].join("\n"),
  };
}
