/**
 * Claude Code Command Handler
 *
 * Handles the /claude command for starting and managing Claude Code sessions.
 *
 * Usage:
 *   /claude juzi              - Start session in juzi project
 *   /claude juzi @experimental - Start in worktree
 *   /claude juzi implement X  - Start with a specific task
 *   /claude resume <token>    - Resume old session
 *   /claude resume <token> X  - Resume with a new task
 *   /claude status            - Show active sessions
 *   /claude cancel <token>    - Cancel a session
 *   /claude say <token> <msg> - Send message to session
 *   /claude projects          - List known projects
 *   /claude register <name> <path> - Register project alias
 *   /claude unregister <name> - Remove project alias
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { logVerbose } from "../../globals.js";
import {
  startSession,
  cancelSessionByToken,
  listSessions,
  getSessionState,
  getCompletedPhases,
  listKnownProjects,
  getConfiguredProjectBases,
  sendInput,
  getSessionByToken,
} from "../../agents/claude-code/index.js";
import {
  createSessionBubble,
  updateSessionBubble,
  completeSessionBubble,
  forwardEventToChat,
  checkRuntimeLimit,
  pauseSession,
  sendRuntimeLimitWarning,
  sendQuestionToChat,
  isSessionPaused,
} from "../../agents/claude-code/bubble-service.js";
import {
  generateOrchestratorResponse,
  shouldAutoContinue,
  logDyDoCommand,
  type OrchestratorContext,
} from "../../agents/claude-code/orchestrator.js";
import { buildPlanningRequest } from "../../agents/claude-code/planning-request.js";
import { callGateway } from "../../gateway/call.js";
import { readConfigFileSnapshot, writeConfigFile } from "../../config/config.js";
import type { CommandHandler } from "./commands-types.js";

/** Default runtime limit in hours */
const DEFAULT_RUNTIME_LIMIT_HOURS = 3.0;

/**
 * Parse /claude command arguments.
 */
function parseClaudeCommand(commandBody: string): {
  hasCommand: boolean;
  action?:
    | "start"
    | "status"
    | "cancel"
    | "list"
    | "projects"
    | "register"
    | "unregister"
    | "say"
    | "resume";
  project?: string;
  prompt?: string;
  token?: string;
  alias?: string;
  aliasPath?: string;
  message?: string;
  quick?: boolean;
} {
  const match = commandBody.match(/^\/claude(?:\s+(.*))?$/i);
  if (!match) return { hasCommand: false };

  let args = match[1]?.trim() ?? "";

  // Check for --quick flag (bypass DyDo planning, go direct to Claude Code)
  const quick = args.includes("--quick");
  if (quick) {
    args = args.replace(/--quick\s*/g, "").trim();
  }

  // /claude status or /claude list
  if (args.toLowerCase() === "status" || args.toLowerCase() === "list") {
    return { hasCommand: true, action: "status" };
  }

  // /claude projects
  if (args.toLowerCase() === "projects") {
    return { hasCommand: true, action: "projects" };
  }

  // /claude cancel <token>
  const cancelMatch = args.match(/^cancel\s+(\S+)/i);
  if (cancelMatch) {
    return { hasCommand: true, action: "cancel", token: cancelMatch[1] };
  }

  // /claude say <token> <message> - send message to session
  const sayMatch = args.match(/^say\s+(\S+)\s+(.+)$/i);
  if (sayMatch) {
    return {
      hasCommand: true,
      action: "say",
      token: sayMatch[1],
      message: sayMatch[2].trim(),
    };
  }

  // /claude resume <token> [prompt] - resume existing session
  const resumeMatch = args.match(/^resume\s+(\S+)(?:\s+(.+))?$/i);
  if (resumeMatch) {
    return {
      hasCommand: true,
      action: "resume",
      token: resumeMatch[1],
      prompt: resumeMatch[2]?.trim(),
    };
  }

  // /claude register <name> <path>
  const registerMatch = args.match(/^register\s+(\S+)\s+(.+)$/i);
  if (registerMatch) {
    return {
      hasCommand: true,
      action: "register",
      alias: registerMatch[1],
      aliasPath: registerMatch[2].trim(),
    };
  }

  // /claude unregister <name>
  const unregisterMatch = args.match(/^unregister\s+(\S+)/i);
  if (unregisterMatch) {
    return { hasCommand: true, action: "unregister", alias: unregisterMatch[1] };
  }

  // /claude <project> [@worktree] [prompt]
  // Prompt can be quoted or just everything after project/worktree
  // Examples:
  //   /claude juzi "implement auth"
  //   /claude juzi @exp implement auth
  //   /claude juzi implement the login feature
  //   /claude juzi --quick fix typo   (bypass planning)
  if (args) {
    // Check for quoted prompt: /claude project "prompt here"
    const quotedMatch = args.match(/^(\S+(?:\s+@\S+)?)\s+"([^"]+)"$/);
    if (quotedMatch) {
      return {
        hasCommand: true,
        action: "start",
        project: quotedMatch[1].trim(),
        prompt: quotedMatch[2].trim(),
        quick,
      };
    }

    // Check for project with unquoted prompt: /claude project rest of the prompt
    // First word (+ optional @worktree) is project, rest is prompt
    const parts = args.match(/^(\S+(?:\s+@\S+)?)\s+(.+)$/);
    if (parts) {
      return {
        hasCommand: true,
        action: "start",
        project: parts[1].trim(),
        prompt: parts[2].trim(),
        quick,
      };
    }

    // Just project, no prompt
    return { hasCommand: true, action: "start", project: args, quick };
  }

  // /claude with no args shows help
  return { hasCommand: true, action: "status" };
}

/**
 * Format session list for display.
 */
function formatSessionList(): string {
  const sessions = listSessions();
  if (sessions.length === 0) {
    return "No active Claude Code sessions.";
  }

  const lines = ["**Active Claude Code Sessions:**", ""];
  for (const session of sessions) {
    const state = getSessionState(session);
    const tokenPrefix = session.resumeToken.slice(0, 8);
    lines.push(`- **${state.projectName}** (${tokenPrefix})`);
    lines.push(`  ${state.runtimeStr} · ${state.status}`);
  }

  return lines.join("\n");
}

/**
 * Format known projects list for display.
 */
function formatProjectsList(): string {
  const projects = listKnownProjects();
  const bases = getConfiguredProjectBases();

  const lines = ["**Known Projects:**", ""];

  // Show explicit aliases first
  const aliases = projects.filter((p) => p.source === "alias");
  if (aliases.length > 0) {
    lines.push("*Registered aliases:*");
    for (const proj of aliases) {
      lines.push(`  \`${proj.name}\` → ${proj.path}`);
    }
    lines.push("");
  }

  // Show discovered projects
  const discovered = projects.filter((p) => p.source === "discovered");
  if (discovered.length > 0) {
    lines.push("*Auto-discovered:*");
    for (const proj of discovered) {
      lines.push(`  \`${proj.name}\` → ${proj.path}`);
    }
    lines.push("");
  }

  // Show search directories
  lines.push("*Search directories:*");
  for (const base of bases) {
    const exists = fs.existsSync(base);
    lines.push(`  ${exists ? "✓" : "✗"} ${base}`);
  }

  return lines.join("\n");
}

/**
 * Expand ~ to home directory.
 */
function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  if (p === "~") {
    return os.homedir();
  }
  return p;
}

/**
 * Register a project alias in config.
 */
async function registerProjectAlias(alias: string, projectPath: string): Promise<string> {
  const expandedPath = expandPath(projectPath);

  // Validate the path exists
  if (!fs.existsSync(expandedPath)) {
    return `Path does not exist: ${expandedPath}`;
  }
  if (!fs.statSync(expandedPath).isDirectory()) {
    return `Path is not a directory: ${expandedPath}`;
  }

  // Read current config
  const snapshot = await readConfigFileSnapshot();
  const config = snapshot.config;

  // Update claudeCode.projects
  const claudeCode = config.claudeCode ?? {};
  const projects = claudeCode.projects ?? {};
  projects[alias] = expandedPath;
  claudeCode.projects = projects;
  config.claudeCode = claudeCode;

  // Write back
  await writeConfigFile(config);

  return `Registered **${alias}** → ${expandedPath}`;
}

/**
 * Unregister a project alias from config.
 */
async function unregisterProjectAlias(alias: string): Promise<string> {
  // Read current config
  const snapshot = await readConfigFileSnapshot();
  const config = snapshot.config;

  const claudeCode = config.claudeCode ?? {};
  const projects = claudeCode.projects ?? {};

  if (!(alias in projects)) {
    return `Alias not found: **${alias}**`;
  }

  delete projects[alias];
  claudeCode.projects = projects;
  config.claudeCode = claudeCode;

  await writeConfigFile(config);

  return `Unregistered alias: **${alias}**`;
}

export const handleClaudeCommand: CommandHandler = async (params, _allowTextCommands) => {
  const parsed = parseClaudeCommand(params.command.commandBodyNormalized);
  if (!parsed.hasCommand) return null;

  // Only authorized senders can use /claude
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /claude from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  // Handle status/list
  if (parsed.action === "status") {
    return {
      shouldContinue: false,
      reply: { text: formatSessionList() },
    };
  }

  // Handle cancel
  if (parsed.action === "cancel" && parsed.token) {
    const success = cancelSessionByToken(parsed.token);
    if (success) {
      return {
        shouldContinue: false,
        reply: { text: `Cancelled session: ${parsed.token}` },
      };
    }
    return {
      shouldContinue: false,
      reply: { text: `Session not found: ${parsed.token}` },
    };
  }

  // Handle projects list
  if (parsed.action === "projects") {
    return {
      shouldContinue: false,
      reply: { text: formatProjectsList() },
    };
  }

  // Handle register
  if (parsed.action === "register" && parsed.alias && parsed.aliasPath) {
    const result = await registerProjectAlias(parsed.alias, parsed.aliasPath);
    return {
      shouldContinue: false,
      reply: { text: result },
    };
  }

  // Handle unregister
  if (parsed.action === "unregister" && parsed.alias) {
    const result = await unregisterProjectAlias(parsed.alias);
    return {
      shouldContinue: false,
      reply: { text: result },
    };
  }

  // Handle say (send message to session)
  if (parsed.action === "say" && parsed.token && parsed.message) {
    const session = getSessionByToken(parsed.token);
    if (!session) {
      return {
        shouldContinue: false,
        reply: { text: `Session not found: ${parsed.token}` },
      };
    }

    const success = sendInput(session.id, parsed.message);
    if (success) {
      return {
        shouldContinue: false,
        reply: {
          text: `Sent to session: "${parsed.message.slice(0, 50)}${parsed.message.length > 50 ? "..." : ""}"`,
        },
      };
    }
    return {
      shouldContinue: false,
      reply: { text: `Failed to send message to session` },
    };
  }

  // Handle resume (resume existing session with token)
  if (parsed.action === "resume" && parsed.token) {
    // Import findSessionFile to get project dir from token
    const { findSessionFile, decodeClaudeProjectPath } =
      await import("../../agents/claude-code/project-resolver.js");

    // Find session file from token
    const sessionFile = findSessionFile(parsed.token);
    if (!sessionFile) {
      return {
        shouldContinue: false,
        reply: { text: `Session not found for token: ${parsed.token}` },
      };
    }

    // Extract project dir from session file path
    // Path format: ~/.claude/projects/-Users-dydo-clawd-projects-juzi/token.jsonl
    const projectKey = path.basename(path.dirname(sessionFile));
    const projectDir = decodeClaudeProjectPath(projectKey);

    if (!fs.existsSync(projectDir)) {
      return {
        shouldContinue: false,
        reply: { text: `Project directory not found: ${projectDir}` },
      };
    }

    // Use the same logic as "start" but with workingDir and resumeToken
    const fromField = params.ctx.From ?? params.command.from ?? "";
    const chatIdMatch = fromField.match(/telegram:(?:group:)?(-?\d+)/);
    const chatId = chatIdMatch?.[1];
    const threadId =
      typeof params.ctx.MessageThreadId === "number"
        ? params.ctx.MessageThreadId
        : typeof params.ctx.MessageThreadId === "string"
          ? parseInt(params.ctx.MessageThreadId, 10)
          : undefined;
    const accountId = params.ctx.AccountId;
    const isTelegram = params.command.channel === "telegram" || params.ctx.Surface === "telegram";

    let sessionId: string | undefined;
    let eventIndex = 0;
    let runtimeLimitWarned = false;
    let workingDir: string | undefined = projectDir;
    let resumeToken: string | undefined = parsed.token;

    const taskPrompt = parsed.prompt || "continue";

    // Log the resume for bubble display
    logDyDoCommand({
      prompt: `Resume: ${taskPrompt}`,
      resumeToken: parsed.token,
      short: `Resume: ${taskPrompt.slice(0, 40)}${taskPrompt.length > 40 ? "..." : ""}`,
      project: path.basename(projectDir),
    });

    const result = await startSession({
      workingDir: projectDir,
      resumeToken: parsed.token,
      permissionMode: "bypassPermissions",
      prompt: taskPrompt,
      onEvent: async (event) => {
        if (!sessionId) return;
        await forwardEventToChat({ sessionId, event, eventIndex: eventIndex++ });
        if (eventIndex % 10 === 0 && !runtimeLimitWarned) {
          const { exceeded, elapsedHours, limitHours } = checkRuntimeLimit(sessionId);
          if (exceeded && !isSessionPaused(sessionId)) {
            runtimeLimitWarned = true;
            pauseSession(sessionId);
            await sendRuntimeLimitWarning({ sessionId, elapsedHours, limitHours });
          }
        }
      },
      onQuestion: async (questionText) => {
        if (!sessionId) return null;
        await sendQuestionToChat({ sessionId, questionText });
        const session = getSessionByToken(resumeToken ?? "");
        const state = session ? getSessionState(session) : undefined;
        const orchestratorContext: OrchestratorContext = {
          projectName: path.basename(projectDir),
          workingDir: workingDir ?? "",
          resumeToken: resumeToken ?? "",
          originalTask: taskPrompt,
          recentActions: state?.recentActions ?? [],
        };
        logVerbose(`[claude-orchestrator] DyDo thinking about: ${questionText.slice(0, 100)}...`);
        const response = await generateOrchestratorResponse(orchestratorContext, questionText);
        logVerbose(`[claude-orchestrator] DyDo decided: ${response.slice(0, 100)}...`);
        return response;
      },
      onStateChange: async (state) => {
        if (!sessionId) return;
        resumeToken = state.resumeToken;
        if (
          state.status === "completed" ||
          state.status === "cancelled" ||
          state.status === "failed"
        ) {
          const completedPhases = getCompletedPhases(params.workspaceDir);
          await completeSessionBubble({ sessionId, state, completedPhases });
        } else if (state.isIdle && !isSessionPaused(sessionId)) {
          const lastAction = state.recentActions.slice(-1)[0];
          const lastMessage = lastAction?.description ?? "";
          const orchestratorContext: OrchestratorContext = {
            projectName: state.projectName,
            workingDir: workingDir ?? "",
            resumeToken: state.resumeToken,
            originalTask: taskPrompt,
            recentActions: state.recentActions,
          };
          const decision = await shouldAutoContinue(orchestratorContext, lastMessage);
          if (decision.shouldContinue && decision.prompt) {
            logVerbose(`[claude-orchestrator] DyDo decided to continue: ${decision.prompt}`);
            const session = getSessionByToken(state.resumeToken);
            if (session) sendInput(session.id, decision.prompt);
          } else {
            await updateSessionBubble({ sessionId, state });
          }
        } else {
          await updateSessionBubble({ sessionId, state });
        }
      },
    });

    if (!result.success) {
      return {
        shouldContinue: false,
        reply: { text: `Failed to resume session: ${result.error}` },
      };
    }

    // Set sessionId IMMEDIATELY so callbacks can work
    sessionId = result.sessionId;

    // Create bubble EARLY for Telegram (before waiting for full init)
    // This ensures events can be forwarded as they arrive
    if (isTelegram && chatId && result.sessionId) {
      // Create initial bubble with the resume token we already have
      const initialState = {
        projectName: path.basename(projectDir),
        status: "running" as const,
        runtimeStr: "0m",
        runtimeSeconds: 0,
        isIdle: false,
        hasQuestion: false,
        questionText: "",
        recentActions: [],
        resumeToken: parsed.token,
        branch: "unknown",
        totalEvents: 0,
        phaseStatus: "Starting",
      };
      await createSessionBubble({
        sessionId: result.sessionId,
        chatId,
        threadId: Number.isFinite(threadId) ? threadId : undefined,
        accountId,
        resumeToken: parsed.token,
        state: initialState,
        workingDir: projectDir,
        runtimeLimitHours: DEFAULT_RUNTIME_LIMIT_HOURS,
      });
    }

    // Now wait for session to fully initialize (to get actual resumeToken if different)
    let session = listSessions().find((s) => s.id === result.sessionId);
    let waitAttempts = 0;
    while (session && !session.resumeToken && waitAttempts < 20) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      session = listSessions().find((s) => s.id === result.sessionId);
      waitAttempts++;
    }

    resumeToken = session?.resumeToken ?? parsed.token;
    workingDir = session?.workingDir ?? projectDir;

    return {
      shouldContinue: false,
      reply: {
        text: `Resuming session **${path.basename(projectDir)}**...\nToken: \`${parsed.token.slice(0, 8)}...\``,
      },
    };
  }

  // Handle start
  if (parsed.action === "start" && parsed.project) {
    // Extract worktree if embedded in project (e.g., "juzi @experimental")
    const projectParts = parsed.project.match(/^(\S+)\s+@(\S+)$/);
    const projectName = projectParts ? projectParts[1] : parsed.project;
    const worktree = projectParts ? projectParts[2] : undefined;

    // ROUTE THROUGH DYDO unless --quick flag is used
    if (!parsed.quick) {
      // Extract chat context for bubble updates
      const fromField = params.ctx.From ?? params.command.from ?? "";
      const chatIdMatch = fromField.match(/telegram:(?:group:)?(-?\d+)/);
      const planChatId = chatIdMatch?.[1];
      const planThreadId =
        typeof params.ctx.MessageThreadId === "number" ? params.ctx.MessageThreadId : undefined;
      const planAccountId = params.ctx.AccountId;

      // Build planning request for DyDo (with chat context for bubbles)
      const planningRequest = buildPlanningRequest({
        action: "start",
        project: projectName,
        task: parsed.prompt,
        worktree,
        quick: false,
        chatContext: planChatId
          ? {
              chatId: planChatId,
              threadId: planThreadId,
              accountId: planAccountId,
            }
          : undefined,
      });

      // Send planning request to DyDo via gateway
      // This runs asynchronously - DyDo will use tools to plan and start
      const sessionKey = params.sessionKey;
      const channel = params.command.channel;
      const accountId = params.ctx.AccountId;

      logVerbose(`[claude-command] Routing to DyDo for planning: ${projectName}`);

      // Fire and forget - DyDo will handle the planning
      void callGateway({
        method: "agent",
        params: {
          sessionKey,
          message: planningRequest,
          channel,
          accountId,
          deliver: true,
          idempotencyKey: `claude-plan-${Date.now()}`,
        },
        timeoutMs: 10_000,
      }).catch((err) => {
        logVerbose(`[claude-command] Failed to route to DyDo: ${err}`);
      });

      // Return acknowledgment to user
      return {
        shouldContinue: false,
        reply: {
          text: `Planning Claude Code session for **${projectName}**${worktree ? ` @${worktree}` : ""}...\n\nI'll analyze the project and may ask clarifying questions before starting.`,
        },
      };
    }

    // --quick mode: Direct to Claude Code (original behavior)
    logVerbose(`[claude-command] Quick mode - direct to Claude Code: ${projectName}`);

    // Extract chat info for bubble creation
    const fromField = params.ctx.From ?? params.command.from ?? "";
    const chatIdMatch = fromField.match(/telegram:(?:group:)?(-?\d+)/);
    const chatId = chatIdMatch?.[1];
    const threadId =
      typeof params.ctx.MessageThreadId === "number"
        ? params.ctx.MessageThreadId
        : typeof params.ctx.MessageThreadId === "string"
          ? parseInt(params.ctx.MessageThreadId, 10)
          : undefined;
    const accountId = params.ctx.AccountId;
    const isTelegram = params.command.channel === "telegram" || params.ctx.Surface === "telegram";

    // Track session ID for bubble updates
    let sessionId: string | undefined;
    let eventIndex = 0;
    let runtimeLimitWarned = false;
    let workingDir: string | undefined;
    let resumeToken: string | undefined;

    // Use the user's prompt if provided, otherwise a default
    const taskPrompt =
      parsed.prompt ||
      "You are now in an interactive session. What would you like me to help with?";

    // Log the initial task for bubble display
    logDyDoCommand({
      prompt: taskPrompt,
      resumeToken: "", // Will be updated once we have it
      short: `Task: ${taskPrompt.slice(0, 50)}${taskPrompt.length > 50 ? "..." : ""}`,
      project: parsed.project,
    });

    const result = await startSession({
      project: parsed.project,
      permissionMode: "bypassPermissions",
      prompt: taskPrompt,
      onEvent: async (event) => {
        if (!sessionId) return;

        // Forward events to chat with emoji formatting
        await forwardEventToChat({
          sessionId,
          event,
          eventIndex: eventIndex++,
        });

        // Check runtime limit (every 10 events to reduce overhead)
        if (eventIndex % 10 === 0 && !runtimeLimitWarned) {
          const { exceeded, elapsedHours, limitHours } = checkRuntimeLimit(sessionId);
          if (exceeded && !isSessionPaused(sessionId)) {
            runtimeLimitWarned = true;
            pauseSession(sessionId);
            await sendRuntimeLimitWarning({ sessionId, elapsedHours, limitHours });
          }
        }
      },
      onQuestion: async (questionText) => {
        if (!sessionId) return null;

        // Forward question to chat for visibility
        await sendQuestionToChat({ sessionId, questionText });

        // AUTONOMOUS MODE: DyDo's AI decides the answer
        // Build orchestrator context
        const session = getSessionByToken(resumeToken ?? "");
        const state = session ? getSessionState(session) : undefined;

        const orchestratorContext: OrchestratorContext = {
          projectName: parsed.project ?? "",
          workingDir: workingDir ?? "",
          resumeToken: resumeToken ?? "",
          originalTask: taskPrompt,
          recentActions: state?.recentActions ?? [],
        };

        logVerbose(`[claude-orchestrator] DyDo thinking about: ${questionText.slice(0, 100)}...`);

        // Let DyDo's AI decide the response
        const response = await generateOrchestratorResponse(orchestratorContext, questionText);

        logVerbose(`[claude-orchestrator] DyDo decided: ${response.slice(0, 100)}...`);
        return response;
      },
      onStateChange: async (state) => {
        if (!sessionId) return;

        // Update tracking variables
        resumeToken = state.resumeToken;

        // Update bubble on state changes
        if (
          state.status === "completed" ||
          state.status === "cancelled" ||
          state.status === "failed"
        ) {
          // Session ended - show completion message
          const completedPhases = getCompletedPhases(params.workspaceDir);
          await completeSessionBubble({
            sessionId,
            state,
            completedPhases,
          });
        } else if (state.isIdle && !isSessionPaused(sessionId)) {
          // AUTONOMOUS MODE: Let DyDo's AI decide whether to continue
          const lastAction = state.recentActions.slice(-1)[0];
          const lastMessage = lastAction?.description ?? "";

          const orchestratorContext: OrchestratorContext = {
            projectName: state.projectName,
            workingDir: workingDir ?? "",
            resumeToken: state.resumeToken,
            originalTask: taskPrompt,
            recentActions: state.recentActions,
          };

          const decision = await shouldAutoContinue(orchestratorContext, lastMessage);

          if (decision.shouldContinue && decision.prompt) {
            // Continue working
            logVerbose(`[claude-orchestrator] DyDo decided to continue: ${decision.prompt}`);
            const session = getSessionByToken(state.resumeToken);
            if (session) {
              sendInput(session.id, decision.prompt);
            }
          } else {
            // Task seems done, update bubble and wait for user
            await updateSessionBubble({ sessionId, state });
          }
        } else {
          // Session running - update bubble
          await updateSessionBubble({ sessionId, state });
        }
      },
    });

    if (!result.success) {
      return {
        shouldContinue: false,
        reply: { text: `Failed to start session: ${result.error}` },
      };
    }

    sessionId = result.sessionId;

    // Wait for session file to be discovered (up to 10 seconds)
    let session = listSessions().find((s) => s.id === result.sessionId);
    let waitAttempts = 0;
    while (session && !session.resumeToken && waitAttempts < 20) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      session = listSessions().find((s) => s.id === result.sessionId);
      waitAttempts++;
    }

    // Update tracking variables for orchestrator context
    resumeToken = session?.resumeToken ?? "";
    workingDir = session?.workingDir ?? "";

    // Create bubble for Telegram
    if (isTelegram && chatId && result.sessionId && resumeToken) {
      if (session) {
        const state = getSessionState(session);
        await createSessionBubble({
          sessionId: result.sessionId,
          chatId,
          threadId: Number.isFinite(threadId) ? threadId : undefined,
          accountId,
          resumeToken,
          state,
          workingDir: session.workingDir,
          runtimeLimitHours: DEFAULT_RUNTIME_LIMIT_HOURS,
        });

        // Return minimal confirmation since bubble shows the status
        const taskPreview = parsed.prompt
          ? `\nTask: ${parsed.prompt.slice(0, 100)}${parsed.prompt.length > 100 ? "..." : ""}`
          : "";
        return {
          shouldContinue: false,
          reply: {
            text: `Starting Claude Code for **${parsed.project}**...${taskPreview}`,
          },
        };
      }
    }

    // Fallback for non-Telegram or if bubble creation failed
    return {
      shouldContinue: false,
      reply: {
        text: `Started Claude Code session for **${parsed.project}**\nSession ID: ${result.sessionId}\nResume token: \`${resumeToken || "(waiting...)"}\``,
      },
    };
  }

  // No valid action
  return {
    shouldContinue: false,
    reply: {
      text: [
        "**Claude Code Commands:**",
        "",
        "`/claude <project> <task>` - Start with a task",
        "`/claude <project>` - Start interactive session",
        "`/claude resume <token> [task]` - Resume old session",
        "`/claude status` - Show active sessions",
        "`/claude cancel <token>` - Cancel a session",
        "`/claude say <token> <msg>` - Send message to session",
        "",
        "**Examples:**",
        "`/claude juzi implement the auth system`",
        "`/claude juzi @exp fix the login bug`",
        "`/claude resume abc123 continue the work`",
        "",
        "**Project Management:**",
        "`/claude projects` - List known projects",
        "`/claude register <name> <path>` - Register alias",
        "`/claude unregister <name>` - Remove alias",
        "",
        "_Sessions auto-pause after 3 hours. Use Continue button to resume._",
      ].join("\n"),
    },
  };
};
