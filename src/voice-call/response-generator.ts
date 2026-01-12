/**
 * Voice call response generator - uses the embedded Pi agent for tool support.
 * Routes voice responses through the same agent infrastructure as messaging.
 */

import crypto from "node:crypto";

import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
} from "../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { resolveAgentIdentity } from "../agents/identity.js";
import { resolveThinkingDefault } from "../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { resolveAgentTimeoutMs } from "../agents/timeout.js";
import { ensureAgentWorkspace } from "../agents/workspace.js";
import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveSessionFilePath,
  resolveStorePath,
  type SessionEntry,
  saveSessionStore,
} from "../config/sessions.js";

import type { VoiceCallConfig } from "./config.js";

export type VoiceResponseParams = {
  /** Voice call config */
  voiceConfig: VoiceCallConfig;
  /** Call ID for session tracking */
  callId: string;
  /** Caller's phone number */
  from: string;
  /** Conversation transcript */
  transcript: Array<{ speaker: "user" | "bot"; text: string }>;
  /** Latest user message */
  userMessage: string;
};

export type VoiceResponseResult = {
  text: string | null;
  error?: string;
};

/**
 * Generate a voice response using the embedded Pi agent with full tool support.
 * Uses the same agent infrastructure as messaging for consistent behavior.
 */
export async function generateVoiceResponse(
  params: VoiceResponseParams,
): Promise<VoiceResponseResult> {
  const { voiceConfig, callId, from, transcript, userMessage } = params;

  const cfg = loadConfig();

  // Build voice-specific session key based on phone number
  const normalizedPhone = from.replace(/\D/g, "");
  const sessionKey = `voice:${normalizedPhone}`;
  const agentId = "main";

  // Resolve paths
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const agentDir = resolveAgentDir(cfg, agentId);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);

  // Ensure workspace exists
  await ensureAgentWorkspace({ dir: workspaceDir });

  // Load or create session entry
  const sessionStore = loadSessionStore(storePath);
  const now = Date.now();
  let sessionEntry = sessionStore[sessionKey] as SessionEntry | undefined;

  if (!sessionEntry) {
    sessionEntry = {
      sessionId: crypto.randomUUID(),
      updatedAt: now,
    };
    sessionStore[sessionKey] = sessionEntry;
    await saveSessionStore(storePath, sessionStore);
  }

  const sessionId = sessionEntry.sessionId;
  const sessionFile = resolveSessionFilePath(sessionId, sessionEntry, {
    agentId,
  });

  // Resolve model from config
  const modelRef =
    voiceConfig.responseModel || `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`;
  const slashIndex = modelRef.indexOf("/");
  const provider =
    slashIndex === -1 ? DEFAULT_PROVIDER : modelRef.slice(0, slashIndex);
  const model = slashIndex === -1 ? modelRef : modelRef.slice(slashIndex + 1);

  // Resolve thinking level
  const thinkLevel = resolveThinkingDefault({ cfg, provider, model });

  // Resolve agent identity for personalized prompt
  const identity = resolveAgentIdentity(cfg, agentId);
  const agentName = identity?.name?.trim() || "assistant";

  // Build system prompt with conversation history
  const basePrompt =
    voiceConfig.responseSystemPrompt ??
    `You are ${agentName}, a helpful voice assistant on a phone call. Keep responses brief and conversational (1-2 sentences max). Be natural and friendly. The caller's phone number is ${from}. You have access to tools - use them when helpful.`;

  let extraSystemPrompt = basePrompt;
  if (transcript.length > 0) {
    const history = transcript
      .map(
        (entry) =>
          `${entry.speaker === "bot" ? "You" : "Caller"}: ${entry.text}`,
      )
      .join("\n");
    extraSystemPrompt = `${basePrompt}\n\nConversation so far:\n${history}`;
  }

  // Resolve timeout
  const timeoutMs =
    voiceConfig.responseTimeoutMs ?? resolveAgentTimeoutMs({ cfg });
  const runId = `voice:${callId}:${Date.now()}`;

  try {
    const result = await runEmbeddedPiAgent({
      sessionId,
      sessionKey,
      messageProvider: "voice",
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: userMessage,
      provider,
      model,
      thinkLevel,
      verboseLevel: "off",
      timeoutMs,
      runId,
      lane: "voice",
      extraSystemPrompt,
      agentDir,
    });

    // Extract text from payloads
    const texts = (result.payloads ?? [])
      .filter((p) => p.text && !p.isError)
      .map((p) => p.text?.trim())
      .filter(Boolean);

    const text = texts.join(" ") || null;

    if (!text && result.meta.aborted) {
      return { text: null, error: "Response generation was aborted" };
    }

    return { text };
  } catch (err) {
    console.error(`[voice-call] Response generation failed:`, err);
    return { text: null, error: String(err) };
  }
}
