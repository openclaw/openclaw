import { runIsolatedCompletion } from "../../agents/isolated-completion.js";
import { prepareUtilityCompletionForAgent } from "../../agents/utility-completion.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { compactProgressText } from "../../shared/text-truncate.js";

const NARRATION_TIMEOUT_MS = 10_000;
const NOTES_IN_PROMPT = 15;
const USER_MESSAGE_PROMPT_CHARS = 500;

const NARRATION_SYSTEM_PROMPT = [
  "You write the live status line for an AI assistant that is working on a chat request.",
  "Describe what the assistant is doing right now in one or two short plain sentences, under 200 characters total.",
  "Use simple present tense and plain language a non-technical reader understands.",
  "No emoji, no markdown, no lists, no tool or API jargon, no quotation marks.",
  "If something failed, mention it briefly.",
  "Reply with the status text only.",
].join(" ");

export type ProgressNarrationInput = {
  userMessage: string;
  activityNotes: readonly string[];
  previousText: string;
};

function buildNarrationUserPrompt(input: ProgressNarrationInput): string {
  const request = compactProgressText(
    input.userMessage.replace(/\s+/g, " ").trim(),
    USER_MESSAGE_PROMPT_CHARS,
  );
  const notes = input.activityNotes.slice(-NOTES_IN_PROMPT);
  return [
    `Request:\n${request || "(none)"}`,
    `Recent activity (oldest first):\n${notes.map((note) => `- ${note}`).join("\n") || "- (none yet)"}`,
    `Previous status: ${input.previousText || "(none)"}`,
  ].join("\n\n");
}

export async function prepareNarrationModel(params: { cfg: OpenClawConfig; agentId: string }) {
  try {
    return await prepareUtilityCompletionForAgent({
      cfg: params.cfg,
      agentId: params.agentId,
      useUtilityModel: true,
    });
  } catch (err) {
    logVerbose(`progress-narrator: model preparation failed: ${String(err)}`);
    return null;
  }
}

export async function generateNarrationWithUtilityModel(params: {
  cfg: OpenClawConfig;
  prepared: NonNullable<Awaited<ReturnType<typeof prepareNarrationModel>>>;
  input: ProgressNarrationInput;
  abortSignal?: AbortSignal;
}): Promise<{ text: string | null; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NARRATION_TIMEOUT_MS);
  const signal = params.abortSignal
    ? AbortSignal.any([params.abortSignal, controller.signal])
    : controller.signal;
  try {
    signal.throwIfAborted();
    const result = await runIsolatedCompletion({
      ...params.prepared,
      purpose: "progress-narration",
      config: params.cfg,
      systemPrompt: NARRATION_SYSTEM_PROMPT,
      prompt: buildNarrationUserPrompt(params.input),
      timeoutMs: NARRATION_TIMEOUT_MS,
      abortSignal: signal,
      answerTokenBudget: 4_096,
      streamParams: { temperature: 0.3 },
    });
    const text = result.text.trim();
    return { text: text || null };
  } catch (err) {
    logVerbose(`progress-narrator: completion failed: ${String(err)}`);
    return { text: null, error: String(err) };
  } finally {
    clearTimeout(timeout);
  }
}
