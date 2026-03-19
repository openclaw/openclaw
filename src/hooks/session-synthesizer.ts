/**
 * LLM-based session content synthesizer for session-memory hook.
 *
 * Distills raw conversation messages into a concise summary of decisions,
 * outcomes, and durable context — similar to the pre-compaction memory flush
 * but triggered on /new or /reset.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAgentWorkspaceDir, resolveAgentDir } from "../agents/agent-scope.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";

const log = createSubsystemLogger("session-synthesizer");

const DEFAULT_SYNTHESIS_PROMPT = `You are summarizing a conversation session that is about to be saved to long-term memory.

Distill the following conversation into a concise summary. Focus on:
- Decisions made and their rationale
- Actions taken and their outcomes
- Key facts, configurations, or state changes
- Problems solved and how
- Open questions or next steps

Omit:
- Greetings, small talk, and filler
- Raw tool output or verbose logs
- Exploratory back-and-forth that led nowhere
- Messages that are just "test", "ok", acknowledgments, or reactions

If the conversation contains nothing worth remembering (e.g., only test messages, greetings, or trivial exchanges), reply with exactly: NO_SUMMARY

Otherwise, write a clean markdown summary (no code fences around the whole thing). Use bullet points for individual items. Be concise — aim for roughly 20-50% of the original length.

Conversation:
`;

/**
 * Synthesize raw session messages into a concise summary using an LLM.
 *
 * Returns the synthesized text, or null if synthesis fails or produces
 * no meaningful output (e.g., trivial conversations).
 */
export async function synthesizeSessionContent(params: {
  sessionContent: string;
  cfg: OpenClawConfig;
  /** Session key used to resolve the correct agent scope in multi-agent setups. */
  sessionKey: string;
}): Promise<string | null> {
  let tempSessionFile: string | null = null;

  try {
    // Resolve the agent from the session key so multi-agent setups use the
    // correct workspace, model, and provider (not always the default agent).
    const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
    const agentDir = resolveAgentDir(params.cfg, agentId);

    // Create a temporary session file for this one-off LLM call
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-synthesis-"));
    tempSessionFile = path.join(tempDir, "session.jsonl");

    // Cap input to avoid blowing context windows on very long sessions
    const truncatedContent = params.sessionContent.slice(0, 12_000);

    const prompt = `${DEFAULT_SYNTHESIS_PROMPT}${truncatedContent}`;

    const { provider, model } = resolveDefaultModelForAgent({
      cfg: params.cfg,
      agentId,
    });

    const result = await runEmbeddedPiAgent({
      sessionId: `session-synthesis-${Date.now()}`,
      sessionKey: params.sessionKey,
      agentId,
      sessionFile: tempSessionFile,
      workspaceDir,
      agentDir,
      config: params.cfg,
      prompt,
      provider,
      model,
      timeoutMs: 30_000, // 30 second timeout (synthesis is heavier than slug gen)
      runId: `synthesis-${Date.now()}`,
      cleanupBundleMcpOnRunEnd: true,
    });

    // Extract text from payloads
    if (result.payloads && result.payloads.length > 0) {
      const text = result.payloads[0]?.text?.trim();
      if (text) {
        // If the LLM determined nothing worth remembering, return null
        if (text === "NO_SUMMARY" || text.startsWith("NO_SUMMARY")) {
          log.debug("LLM determined session has nothing worth summarizing");
          return null;
        }
        return text;
      }
    }

    return null;
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.error(`Failed to synthesize session content: ${message}`);
    return null;
  } finally {
    // Clean up temporary session file
    if (tempSessionFile) {
      try {
        await fs.rm(path.dirname(tempSessionFile), { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}
