import { randomUUID } from "node:crypto";
import { callGateway, randomIdempotencyKey } from "../../gateway/call.js";
import { logVerbose } from "../../globals.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import type { CommandHandler } from "./commands-types.js";

const SUMMARIZE_TIMEOUT_MS = 120_000;
const SUMMARIZE_NO_OUTPUT_TIMEOUT_MS = 45_000;
const SUMMARIZE_MAX_REPLY_CHARS = 12_000;
const SUMMARIZE_DEFAULT_LENGTH = "medium";
const SUMMARIZE_AGENT_TIMEOUT_SECONDS = 120;
const SUMMARIZE_AGENT_TIMEOUT_MS = SUMMARIZE_AGENT_TIMEOUT_SECONDS * 1000;

type SummarizeExtractResponse = {
  extracted?: {
    title?: string;
    content?: string;
  };
};

type GatewayAgentResponse = {
  summary?: string;
  result?: {
    payloads?: Array<{
      text?: string;
    }>;
  };
};

function parseSummarizeInput(commandBodyNormalized: string): string | null {
  const normalized = commandBodyNormalized.trim();
  if (normalized === "/summarize") {
    return "";
  }
  if (normalized.startsWith("/summarize ")) {
    return normalized.slice("/summarize".length).trim();
  }
  return null;
}

function isYouTubeInput(input: string): boolean {
  return /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/|live\/))/i.test(input);
}

function stripTranscriptPrefix(text: string): string {
  return text.replace(/^transcript:\s*/i, "").trim();
}

function parseExtractedContent(stdout: string): { title?: string; content: string } | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = JSON.parse(trimmed) as SummarizeExtractResponse;
  const content = stripTranscriptPrefix(String(parsed.extracted?.content ?? ""));
  if (!content) {
    return null;
  }
  const title = String(parsed.extracted?.title ?? "").trim() || undefined;
  return { title, content };
}

function buildAgentSummaryPrompt(params: {
  input: string;
  title?: string;
  transcript: string;
}): string {
  const titleLine = params.title ? `Video title: ${params.title}\n` : "";
  return (
    "Summarize the following YouTube video transcript.\n" +
    "Return only a concise summary with the main points, key takeaways, and notable conclusions.\n" +
    "Do not return the transcript. Do not quote large passages. Use plain text.\n\n" +
    `Source URL: ${params.input}\n` +
    titleLine +
    "\nTranscript:\n" +
    params.transcript
  );
}

function extractGatewayReplyText(response: GatewayAgentResponse | null | undefined): string {
  const payloads = response?.result?.payloads ?? [];
  const text = payloads
    .map((payload) => (typeof payload?.text === "string" ? payload.text.trim() : ""))
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return text || String(response?.summary ?? "").trim();
}

function trimReply(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= SUMMARIZE_MAX_REPLY_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, SUMMARIZE_MAX_REPLY_CHARS)}\n\n…(truncated)`;
}

function formatFailureDetails(stdout: string, stderr: string): string {
  const detail = stderr.trim() || stdout.trim();
  if (!detail) {
    return "No additional error details were returned.";
  }
  return trimReply(detail);
}

export const handleSummarizeCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const input = parseSummarizeInput(params.command.commandBodyNormalized);
  if (input === null) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /summarize from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  if (!input) {
    return {
      shouldContinue: false,
      reply: {
        text: "⚠️ Usage: /summarize <url|path|text>",
      },
    };
  }

  try {
    if (isYouTubeInput(input)) {
      const extractResult = await runCommandWithTimeout(
        ["summarize", input, "--youtube", "auto", "--extract", "--json", "--plain", "--no-color"],
        {
          timeoutMs: SUMMARIZE_TIMEOUT_MS,
          noOutputTimeoutMs: SUMMARIZE_NO_OUTPUT_TIMEOUT_MS,
        },
      );

      if (
        extractResult.termination === "timeout" ||
        extractResult.termination === "no-output-timeout"
      ) {
        return {
          shouldContinue: false,
          reply: {
            text:
              "⚠️ /summarize timed out before completion.\n" +
              "Try a shorter target, or run again when the source is reachable.",
          },
        };
      }

      if ((extractResult.code ?? 1) !== 0) {
        return {
          shouldContinue: false,
          reply: {
            text: `❌ /summarize failed.\n${formatFailureDetails(
              extractResult.stdout,
              extractResult.stderr,
            )}`,
          },
        };
      }

      let extracted: { title?: string; content: string } | null = null;
      try {
        extracted = parseExtractedContent(extractResult.stdout);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          shouldContinue: false,
          reply: {
            text: `❌ /summarize failed.\nInvalid summarize extract output: ${trimReply(message)}`,
          },
        };
      }

      if (!extracted?.content) {
        return {
          shouldContinue: false,
          reply: {
            text: "⚠️ /summarize completed but returned no transcript content.",
          },
        };
      }

      const summaryResponse = await callGateway<GatewayAgentResponse>({
        method: "agent",
        params: {
          agentId: normalizeAgentId(params.agentId ?? "main"),
          sessionKey: `agent:${normalizeAgentId(params.agentId ?? "main")}:summarize:${randomUUID()}`,
          message: buildAgentSummaryPrompt({
            input,
            title: extracted.title,
            transcript: extracted.content,
          }),
          thinking: "low",
          deliver: false,
          channel: INTERNAL_MESSAGE_CHANNEL,
          timeout: SUMMARIZE_AGENT_TIMEOUT_SECONDS,
          idempotencyKey: randomIdempotencyKey(),
        },
        expectFinal: true,
        timeoutMs: SUMMARIZE_AGENT_TIMEOUT_MS + 30_000,
      });

      const summaryText = extractGatewayReplyText(summaryResponse);
      if (!summaryText) {
        return {
          shouldContinue: false,
          reply: {
            text: "⚠️ /summarize completed but returned no summary.",
          },
        };
      }

      return {
        shouldContinue: false,
        reply: { text: trimReply(summaryText) },
      };
    }

    const result = await runCommandWithTimeout(
      ["summarize", input, "--force-summary", "--length", SUMMARIZE_DEFAULT_LENGTH],
      {
        timeoutMs: SUMMARIZE_TIMEOUT_MS,
        noOutputTimeoutMs: SUMMARIZE_NO_OUTPUT_TIMEOUT_MS,
      },
    );

    if (result.termination === "timeout" || result.termination === "no-output-timeout") {
      return {
        shouldContinue: false,
        reply: {
          text:
            "⚠️ /summarize timed out before completion.\n" +
            "Try a shorter target, or run again when the source is reachable.",
        },
      };
    }

    if ((result.code ?? 1) !== 0) {
      return {
        shouldContinue: false,
        reply: {
          text: `❌ /summarize failed.\n${formatFailureDetails(result.stdout, result.stderr)}`,
        },
      };
    }

    const summaryText = (result.stdout.trim() || result.stderr.trim()).trim();
    if (!summaryText) {
      return {
        shouldContinue: false,
        reply: {
          text: "⚠️ /summarize completed but returned no output.",
        },
      };
    }

    return {
      shouldContinue: false,
      reply: { text: trimReply(summaryText) },
    };
  } catch (err) {
    const rawCode =
      typeof err === "object" && err && "code" in err ? (err as { code?: unknown }).code : "";
    const code = typeof rawCode === "string" ? rawCode.trim() : "";
    if (code === "ENOENT") {
      return {
        shouldContinue: false,
        reply: {
          text:
            "⚠️ /summarize is unavailable: `summarize` CLI not found.\n" +
            "Install it on the gateway runtime and restart.\n" +
            "If running in Docker, rebuild and recreate the gateway container from this repo image.",
        },
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      shouldContinue: false,
      reply: {
        text: `❌ /summarize failed.\n${trimReply(message)}`,
      },
    };
  }
};
