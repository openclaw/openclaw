/**
 * Claude Code Start Tool for DyDo
 *
 * Allows DyDo to spawn Claude Code sessions with enriched context
 * after planning phase. This tool:
 * - Starts Claude Code session with DyDo's refined prompt
 * - Stores session context for later Q&A handling
 * - Returns session info for monitoring
 */

import path from "node:path";
import { Type } from "@sinclair/typebox";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  startSession,
  resolveProject,
  getGitBranch,
  getSession,
  getSessionState,
  getSessionByToken,
  sendInput,
} from "../claude-code/index.js";
import {
  createSessionBubble,
  updateSessionBubble,
  recordCCQuestion,
  recordDyDoAnswer,
} from "../claude-code/bubble-service.js";
import {
  generateOrchestratorResponse,
  assessQuestion,
  getAttemptHistory,
  recordAttempt,
  isSimilarQuestion,
  clearAttemptHistory,
} from "../claude-code/orchestrator.js";
import type { OrchestratorContext, OrchestratorAttempt } from "../claude-code/orchestrator.js";
import type { ProjectContext } from "../claude-code/project-context.js";
import type { SessionState } from "../claude-code/types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const log = createSubsystemLogger("tools/claude-code-start");

/**
 * Session planning context stored for Q&A routing
 */
export interface SessionPlanningContext {
  /** DyDo's session ID (requester) */
  dyDoSessionId: string;
  /** Project context from exploration */
  projectContext?: ProjectContext;
  /** Original user task */
  originalTask: string;
  /** DyDo's enriched prompt */
  enrichedPrompt: string;
  /** Planning decisions made */
  planningDecisions: string[];
  /** Clarifications from user */
  userClarifications: string[];
  /** Timestamp when planning started */
  planningStartedAt: number;
}

/**
 * Map of Claude Code sessionId -> planning context
 * Used for Q&A routing to give DyDo full context
 */
const sessionContexts = new Map<string, SessionPlanningContext>();

/**
 * Forced resume token context, keyed by chatId.
 * When set, claude_code_start will use this token regardless of what DyDo passes.
 * This ensures code-level enforcement for bubble reply resume operations.
 * Using a Map prevents concurrent requests from overwriting each other.
 */
const forcedResumeTokens = new Map<string, string>();

/**
 * Set a forced resume token for a specific chat.
 * The token will be cleared after claude_code_start uses it.
 */
export function setForcedResumeToken(token: string, chatId?: string): void {
  const key = chatId || "default";
  log.info(`[FORCED TOKEN] Setting for chat ${key}: ${token.slice(0, 8)}...`);
  forcedResumeTokens.set(key, token);
}

/**
 * Get and clear the forced resume token for a specific chat.
 */
function consumeForcedResumeToken(chatId?: string): string | undefined {
  const key = chatId || "default";
  const token = forcedResumeTokens.get(key);
  if (token) {
    forcedResumeTokens.delete(key);
    log.info(`[FORCED TOKEN] Consuming for chat ${key}: ${token.slice(0, 8)}...`);
  } else {
    log.info(`[FORCED TOKEN] None set for chat ${key} - using DyDo's value`);
  }
  return token;
}

/**
 * Get planning context for a Claude Code session
 */
export function getSessionPlanningContext(sessionId: string): SessionPlanningContext | undefined {
  return sessionContexts.get(sessionId);
}

/**
 * Store planning context for a session
 */
export function setSessionPlanningContext(
  sessionId: string,
  context: SessionPlanningContext,
): void {
  sessionContexts.set(sessionId, context);
}

/**
 * Remove planning context (on session end)
 */
export function clearSessionPlanningContext(sessionId: string): void {
  sessionContexts.delete(sessionId);
}

const ClaudeCodeStartToolSchema = Type.Object({
  project: Type.String({ description: "Project name or path" }),
  prompt: Type.String({ description: "The enriched prompt for Claude Code" }),
  originalTask: Type.Optional(Type.String({ description: "Original user task before enrichment" })),
  worktree: Type.Optional(
    Type.String({ description: "Worktree/branch name (e.g., @experimental)" }),
  ),
  planningDecisions: Type.Optional(
    Type.Array(Type.String(), { description: "Decisions made during planning" }),
  ),
  userClarifications: Type.Optional(
    Type.Array(Type.String(), { description: "Clarifications from user" }),
  ),
  resumeToken: Type.Optional(
    Type.String({ description: "Resume token for continuing existing session" }),
  ),
  // Chat context for bubble updates (passed from planning request)
  chatId: Type.Optional(Type.String({ description: "Telegram chat ID for bubble updates" })),
  threadId: Type.Optional(Type.Number({ description: "Telegram thread/topic ID" })),
  accountId: Type.Optional(Type.String({ description: "Account ID for multi-account support" })),
});

export function createClaudeCodeStartTool(options?: {
  dyDoSessionId?: string;
  onSessionStart?: (sessionId: string, context: SessionPlanningContext) => void;
}): AnyAgentTool {
  return {
    label: "Claude Code",
    name: "claude_code_start",
    description: `Start a Claude Code session with your enriched prompt and context.

Use this after:
1. Loading project context with project_context tool
2. Analyzing the task
3. Asking user for any clarifications
4. Formulating a detailed, enriched prompt

The session will run in background. You'll receive questions via conversation.`,
    parameters: ClaudeCodeStartToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const projectInput = readStringParam(params, "project", { required: true });
      const prompt = readStringParam(params, "prompt", { required: true });
      const originalTask = readStringParam(params, "originalTask") || prompt;
      const worktree = readStringParam(params, "worktree");

      // Extract chat context for bubble updates (need chatId early for forced token lookup)
      const chatId = readStringParam(params, "chatId");

      // Check for forced resume token first (code-level enforcement for bubble replies)
      // This ensures the correct token is used even if DyDo passes wrong/no token
      const forcedToken = consumeForcedResumeToken(chatId);
      const passedToken = readStringParam(params, "resumeToken");
      const resumeToken = forcedToken || passedToken;

      if (forcedToken && passedToken && forcedToken !== passedToken) {
        log.warn(
          `Overriding DyDo's resumeToken (${passedToken?.slice(0, 8)}...) with forced token (${forcedToken.slice(0, 8)}...)`,
        );
      }

      log.info(
        `[RESUME] Final token decision: forced=${forcedToken?.slice(0, 8) || "none"}, passed=${passedToken?.slice(0, 8) || "none"}, using=${resumeToken?.slice(0, 8) || "NEW SESSION"}`,
      );

      // Check if session is already actively running - prevent duplicate resume
      if (resumeToken) {
        const existingSession = getSessionByToken(resumeToken);
        if (existingSession) {
          // Only prevent duplicate if session is actually running
          // If session is done/completed/cancelled/failed, we should spawn a new process to resume
          const isRunning = existingSession.status === "running";

          if (isRunning) {
            log.info(
              `[DUPLICATE PREVENTION] Session ${resumeToken.slice(0, 8)}... is actively running (id=${existingSession.id}, status=${existingSession.status}), sending input instead of spawning new`,
            );

            // Send the prompt as input to the existing session
            const inputSent = sendInput(existingSession.id, prompt);
            if (inputSent) {
              return jsonResult({
                status: "already_running",
                message:
                  "Session is already active - your message was sent to the existing session",
                sessionId: existingSession.id,
                resumeToken: existingSession.resumeToken,
                bubbleExists: true,
              });
            } else {
              log.warn(`[DUPLICATE PREVENTION] Failed to send input to existing session`);
              // Fall through to spawn new session if input failed
            }
          } else {
            log.info(
              `[DUPLICATE PREVENTION] Session ${resumeToken.slice(0, 8)}... exists but is not running (status=${existingSession.status}), will spawn new process to resume`,
            );
            // Fall through to spawn new session
          }
        }
      }

      const planningDecisions = Array.isArray(params.planningDecisions)
        ? (params.planningDecisions as string[])
        : [];
      const userClarifications = Array.isArray(params.userClarifications)
        ? (params.userClarifications as string[])
        : [];

      // Extract remaining chat context for bubble updates (chatId already extracted above)
      const threadId = typeof params.threadId === "number" ? params.threadId : undefined;
      const accountId = readStringParam(params, "accountId");

      // Resolve project path
      let projectPath: string | undefined;
      let projectName: string = projectInput; // Default to input

      // CRITICAL: If resuming, get working directory from the resume token first!
      // The session file location tells us the exact directory the session was created in.
      // Using a different directory will cause Claude to create a new session instead.
      if (resumeToken) {
        const { getWorkingDirFromResumeToken } = await import("../claude-code/index.js");
        const tokenWorkingDir = getWorkingDirFromResumeToken(resumeToken);
        if (tokenWorkingDir) {
          projectPath = tokenWorkingDir;
          projectName = path.basename(tokenWorkingDir);
          // Check for worktree pattern to get better display name
          const worktreeMatch = tokenWorkingDir.match(/(.+)\/\.worktrees\/([^/]+)$/);
          if (worktreeMatch) {
            projectName = `${path.basename(worktreeMatch[1])} @${worktreeMatch[2]}`;
          }
          log.info(`[RESUME] Using working dir from token: ${projectPath} (${projectName})`);
        } else {
          log.warn(
            `[RESUME] Could not find session file for token ${resumeToken.slice(0, 8)}..., falling back to project resolution`,
          );
        }
      }

      // Fall back to project resolution if we don't have a path yet
      if (!projectPath) {
        // Check if it's a path
        if (projectInput.startsWith("/")) {
          projectPath = projectInput;
          projectName = path.basename(projectInput);
        } else {
          // Try to resolve as project name
          const projectSpec = worktree ? `${projectInput} @${worktree}` : projectInput;
          const resolved = resolveProject(projectSpec);

          if (resolved) {
            projectPath = resolved.workingDir;
            // Extract project name from displayName (e.g., "juzi @experimental" -> "juzi")
            projectName = resolved.displayName.split(" ")[0] || projectInput;
          } else {
            // Try common locations
            const commonBases = [
              "/Users/dydo/Documents/agent",
              "/Users/dydo/clawd/projects",
              "/Users/dydo",
            ];

            for (const base of commonBases) {
              const candidate = path.join(base, projectInput);
              const fs = require("node:fs");
              if (fs.existsSync(candidate)) {
                projectPath = candidate;
                projectName = projectInput;
                break;
              }
            }
          }
        }
      }

      if (!projectPath) {
        return jsonResult({
          status: "error",
          error: `Could not resolve project: ${projectInput}. Provide full path or register the project.`,
        });
      }

      log.info(`Starting Claude Code session for ${projectName} at ${projectPath}`);
      log.info(`Prompt: ${prompt.slice(0, 100)}...`);

      // Create planning context
      const planningContext: SessionPlanningContext = {
        dyDoSessionId: options?.dyDoSessionId || "unknown",
        originalTask,
        enrichedPrompt: prompt,
        planningDecisions,
        userClarifications,
        planningStartedAt: Date.now(),
      };

      // Try to load project context if available
      try {
        const { loadProjectContext } = await import("../claude-code/project-context.js");
        const projectCtx = loadProjectContext(projectName);
        if (projectCtx) {
          planningContext.projectContext = projectCtx;
        }
      } catch {
        // Ignore - project context is optional
      }

      let sessionId: string | undefined;
      let currentResumeToken = resumeToken;

      try {
        // Start the Claude Code session with event handlers
        const result = await startSession({
          workingDir: projectPath,
          prompt,
          resumeToken,
          permissionMode: "bypassPermissions",
          // Note: No onEvent handler - events are shown in the bubble via recentActions from onStateChange

          // State change handler: update bubble
          onStateChange: async (state: SessionState) => {
            if (!sessionId || !chatId) return;
            currentResumeToken = state.resumeToken;

            // Update the bubble with new state
            await updateSessionBubble({ sessionId, state });
          },

          // Blocker handler: notify DyDo when session hits a blocker
          onBlocker: async (blocker) => {
            if (!sessionId) return false;

            log.warn(
              `[${sessionId}] Blocker detected: ${blocker.reason} (category: ${blocker.matchedPatterns[0] || "unknown"})`,
            );

            // Store blocker info in planning context for later retrieval
            const context = sessionContexts.get(sessionId);
            if (context) {
              (context as SessionPlanningContext & { blockerInfo?: unknown }).blockerInfo = blocker;
            }

            // Send notification to chat if available
            if (chatId) {
              try {
                const { sendMessageTelegram } = await import("../../telegram/send.js");
                const blockerMsg =
                  `⚠️ **Claude Code Session Blocked**\n\n` +
                  `**Project:** ${projectName}\n` +
                  `**Reason:** ${blocker.reason}\n\n` +
                  `Session has completed but may need attention.\n\n` +
                  `\`claude --resume ${currentResumeToken}\``;

                await sendMessageTelegram(String(chatId), blockerMsg, {
                  accountId,
                  messageThreadId: threadId,
                  disableLinkPreview: true,
                });

                log.info(`[${sessionId}] Blocker notification sent to chat ${chatId}`);
              } catch (err) {
                log.error(`[${sessionId}] Failed to send blocker notification: ${err}`);
              }
            }

            // Return false to let session complete (but blocker is recorded)
            // Return true would keep session in "blocked" state, waiting for intervention
            return false;
          },

          // Question handler: route CC questions to DyDo with AI-driven blocker detection
          onQuestion: async (question: string): Promise<string | null> => {
            if (!sessionId) return null;

            log.info(`[${sessionId}] CC question: ${question.slice(0, 100)}...`);

            // Record question in bubble state (shows expanded Q&A)
            recordCCQuestion(sessionId, question);

            // Trigger bubble update to show "DyDo thinking..."
            const session = getSession(sessionId);
            if (session) {
              await updateSessionBubble({ sessionId, state: getSessionState(session) });
            }

            // Build orchestrator context from planning context
            const orchestratorContext: OrchestratorContext = {
              projectName,
              workingDir: projectPath,
              resumeToken: currentResumeToken ?? sessionId,
              originalTask,
              recentActions: session ? getSessionState(session).recentActions : [],
            };

            try {
              // Step 1: AI assessment - Can DyDo handle this question?
              const assessment = await assessQuestion(orchestratorContext, question);

              // Step 1a: Check if impossible (need user immediately)
              if (assessment.confidence === "impossible") {
                log.warn(
                  `[${sessionId}] DyDo cannot handle: ${question.slice(0, 100)}... (${assessment.reasoning})`,
                );

                // Notify user via Telegram
                if (chatId) {
                  try {
                    const { sendMessageTelegram } = await import("../../telegram/send.js");
                    const blockerMsg =
                      `⚠️ **Claude Code 需要你的輸入**\n\n` +
                      `**專案：** ${projectName}\n` +
                      `**問題：** ${question}\n\n` +
                      `**DyDo 判斷：** ${assessment.reasoning || "這需要你的決定"}\n\n` +
                      `\`claude --resume ${currentResumeToken}\``;

                    await sendMessageTelegram(String(chatId), blockerMsg, {
                      accountId,
                      messageThreadId: threadId,
                      disableLinkPreview: true,
                    });

                    log.info(`[${sessionId}] User blocker notification sent`);
                  } catch (err) {
                    log.error(`[${sessionId}] Failed to send blocker notification: ${err}`);
                  }
                }

                recordDyDoAnswer(sessionId);
                return null; // True blocker - wait for user
              }

              // Step 2: Check retry history
              const history = getAttemptHistory(sessionId);
              const similarAttempts = history.filter((a) =>
                isSimilarQuestion(a.question, question),
              );

              if (similarAttempts.length >= 3) {
                log.warn(
                  `[${sessionId}] DyDo failed 3 times on similar questions - escalating to user`,
                );

                // Notify user: DyDo tried but failed multiple times
                if (chatId) {
                  try {
                    const { sendMessageTelegram } = await import("../../telegram/send.js");
                    const blockerMsg =
                      `⚠️ **Claude Code 重複卡住**\n\n` +
                      `**專案：** ${projectName}\n` +
                      `**問題：** ${question}\n\n` +
                      `**DyDo 狀態：** 我已嘗試 ${similarAttempts.length} 次，仍無法解決\n\n` +
                      `**之前的回答：**\n${similarAttempts.map((a, i) => `${i + 1}. ${a.myAnswer.slice(0, 80)}...`).join("\n")}\n\n` +
                      `\`claude --resume ${currentResumeToken}\``;

                    await sendMessageTelegram(String(chatId), blockerMsg, {
                      accountId,
                      messageThreadId: threadId,
                      disableLinkPreview: true,
                    });

                    log.info(`[${sessionId}] Retry blocker notification sent`);
                  } catch (err) {
                    log.error(`[${sessionId}] Failed to send retry blocker: ${err}`);
                  }
                }

                recordDyDoAnswer(sessionId);
                return null; // Retry blocker - need user intervention
              }

              // Step 3: Generate answer
              const answer = await generateOrchestratorResponse(orchestratorContext, question);

              log.info(
                `[${sessionId}] DyDo answer (confidence: ${assessment.confidence}): ${answer.slice(0, 100)}...`,
              );

              // Step 4: Record this attempt
              recordAttempt(sessionId, {
                question,
                myAnswer: answer,
                confidence: assessment.confidence,
                timestamp: Date.now(),
              });

              // Record answer in bubble state (collapses Q&A, shows summary)
              recordDyDoAnswer(sessionId);

              // Trigger bubble update to show collapsed Q&A
              const updatedSession = getSession(sessionId);
              if (updatedSession) {
                await updateSessionBubble({ sessionId, state: getSessionState(updatedSession) });
              }

              return answer;
            } catch (err) {
              log.error(`[${sessionId}] Failed to get DyDo answer: ${err}`);
              // Fall back to a safe default
              recordDyDoAnswer(sessionId);
              return "Use your best judgment and proceed.";
            }
          },
        });

        if (!result.success) {
          return jsonResult({
            status: "error",
            error: result.error || "Failed to start Claude Code session",
          });
        }

        sessionId = result.sessionId;
        currentResumeToken = result.resumeToken;

        // Store planning context for Q&A routing
        if (sessionId) {
          setSessionPlanningContext(sessionId, planningContext);

          // Notify callback if provided
          if (options?.onSessionStart) {
            options.onSessionStart(sessionId, planningContext);
          }

          // CRITICAL: Create bubble IMMEDIATELY so events have somewhere to go
          // This follows takopi's pattern: tracker first, then events flow to it
          if (chatId) {
            const session = getSession(sessionId);
            const initialState: SessionState = session
              ? getSessionState(session)
              : {
                  projectName: projectName + (worktree ? ` @${worktree}` : ""),
                  status: "running",
                  branch: worktree || "main",
                  resumeToken: currentResumeToken ?? sessionId,
                  runtimeStr: "0m",
                  runtimeSeconds: 0,
                  phaseStatus: "Starting...",
                  totalEvents: 0,
                  recentActions: [],
                  isIdle: false,
                  hasQuestion: false,
                  questionText: "",
                };

            await createSessionBubble({
              sessionId,
              chatId,
              threadId,
              accountId,
              resumeToken: currentResumeToken ?? sessionId,
              state: initialState,
              workingDir: projectPath,
            });
            log.info(`[${sessionId}] Created bubble IMMEDIATELY in chat ${chatId}`);
          }

          // Now wait for session to be fully initialized and update bubble
          let session = getSession(sessionId);
          let waitAttempts = 0;
          while (session && !session.resumeToken && waitAttempts < 20) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            session = getSession(sessionId);
            waitAttempts++;
          }

          // Update bubble with complete state once available
          if (session?.resumeToken) {
            currentResumeToken = session.resumeToken;
            if (chatId) {
              const state = getSessionState(session);
              await updateSessionBubble({ sessionId, state });
              log.info(`[${sessionId}] Updated bubble with complete state`);
            }
          }
        }

        log.info(`Claude Code session started: ${sessionId}`);

        return jsonResult({
          status: "ok",
          sessionId,
          resumeToken: currentResumeToken,
          project: projectName,
          workingDir: projectPath,
          branch: getGitBranch(projectPath),
          message: `Claude Code session started for ${projectName}. ${chatId ? "Live updates will appear in chat." : "No chat context - updates won't be visible."}`,
        });
      } catch (err) {
        log.error(`Failed to start Claude Code session: ${err}`);
        return jsonResult({
          status: "error",
          error: `Failed to start session: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  };
}
