import OpenAI from "openai";
import { resolveAgentConfig } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/config.js";
import { normalizeSecretInputString } from "../../config/types.secrets.js";
import type { EncodedEpisode } from "./types.js";

const ENCODER_SYSTEM_PROMPT = `You are an episodic memory encoder. Extract memorable episodes from the following conversation.

## Extraction rules
1. Only extract information with long-term value (decisions, preferences, commitments, important findings)
2. Ignore purely operational content ("search for X" → skip, but "searched and found X is important" → keep)
3. Prioritize emotionally significant interactions (surprise, frustration, excitement)
4. Explicitly stated user preferences and opinions must always be extracted

## Output format (JSON)
{
  "episodes": [
    {
      "summary": "One-sentence description of what happened",
      "details": "Key details, preserve specific data/numbers",
      "importance": <number between 0.0 and 1.0>,
      "emotional_valence": <number between -1.0 (negative) and 1.0 (positive)>,
      "emotional_arousal": <number between 0.0 (calm) and 1.0 (excited)>,
      "topic_tags": ["tag1", "tag2"],
      "participants": ["user", "assistant"]
    }
  ],
  "no_episodes_reason": "If no memorable episodes exist, explain why"
}

Respond ONLY with valid JSON, no markdown fences.`;

export interface EncoderConfig {
  model?: string;
  embeddingModel?: string;
  minConversationLength?: number; // minimum chars
  importanceThreshold?: number;
  chatBaseUrl?: string;
  embeddingBaseUrl?: string;
  apiKey?: string;
}

export class EpisodeEncoder {
  private chatClient: OpenAI;
  private embeddingClient: OpenAI;
  private config: Required<EncoderConfig>;

  constructor(config: EncoderConfig = {}) {
    const apiKey = config.apiKey ?? process.env["OPENAI_API_KEY"] ?? "local-key";
    const chatBaseUrl = config.chatBaseUrl ?? process.env["OPENAI_BASE_URL"] ?? undefined;
    const embeddingBaseUrl =
      config.embeddingBaseUrl ?? process.env["EMBEDDING_BASE_URL"] ?? chatBaseUrl ?? undefined;

    this.config = {
      model: config.model ?? process.env["OPENAI_CHAT_MODEL"] ?? "gpt-4o-mini",
      embeddingModel:
        config.embeddingModel ?? process.env["EMBEDDING_MODEL"] ?? "text-embedding-3-small",
      minConversationLength: config.minConversationLength ?? 200,
      importanceThreshold: config.importanceThreshold ?? 0.3,
      chatBaseUrl: chatBaseUrl ?? "",
      embeddingBaseUrl: embeddingBaseUrl ?? "",
      apiKey,
    };

    this.chatClient = new OpenAI({
      apiKey,
      baseURL: chatBaseUrl,
    });

    this.embeddingClient = new OpenAI({
      apiKey,
      baseURL: embeddingBaseUrl,
    });
  }

  /**
   * Strip tool calls, XML blocks, system metadata, and other non-conversational
   * content from a raw session transcript before passing to the LLM encoder.
   * This prevents reasoning models from treating tool-call XML as instructions.
   */
  private sanitizeTranscript(text: string): string {
    return (
      text
        // Remove XML-style tool call blocks (MiniMax, custom agents, etc.)
        .replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/g, "[tool call]")
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "[tool call]")
        .replace(/<invoke[\s\S]*?<\/invoke>/g, "[tool call]")
        // Remove JSON tool result blocks (often large/noisy)
        .replace(/```json\n\{[\s\S]{500,}?\}\n```/g, "[tool result omitted]")
        // Remove long code blocks (>200 chars) that aren't conversation
        .replace(/```[\s\S]{200,}?```/g, "[code block omitted]")
        // Remove ANSI escape codes (ESC char — eslint-disable-next-line no-control-regex)
        // eslint-disable-next-line no-control-regex
        .replace(/\u001b\[[0-9;]*m/g, "")
        // Collapse 3+ blank lines to 2
        .replace(/\n{3,}/g, "\n\n")
        .trim()
    );
  }

  async encode(conversationText: string, _agentId: string = "default"): Promise<EncodedEpisode[]> {
    const cleanedText = this.sanitizeTranscript(conversationText);

    if (cleanedText.length < this.config.minConversationLength) {
      return [];
    }

    try {
      const response = await this.chatClient.chat.completions.create({
        model: this.config.model,
        messages: [
          { role: "system", content: ENCODER_SYSTEM_PROMPT },
          {
            role: "user",
            content: `Extract episodic memories from the following conversation:\n\n${cleanedText}`,
          },
        ],
        temperature: 0.3,
        max_tokens: 2048,
      });

      const rawMessage = response.choices[0]?.message as
        | { content?: string | null; reasoning_content?: string | null }
        | undefined;
      // Some reasoning models (MiniMax-M2.5 via sglang) mix CoT into content.
      // If reasoning_content is populated, content is the clean answer; otherwise scan content.
      const answerContent = rawMessage?.reasoning_content
        ? rawMessage.content // reasoning separated → use content directly
        : rawMessage?.content; // reasoning mixed in → still use content, but scan smarter
      const content = answerContent;
      if (!content) {
        return [];
      }

      // Robustly extract JSON: strip markdown fences, then find outermost {"episodes":[...]}
      // Also handles reasoning models (MiniMax, DeepSeek) that prepend chain-of-thought
      // before the final JSON answer. We scan all { positions from the end.
      const cleaned = content
        .replace(/^```(?:json)?\s*\n?/gm, "") // opening fence
        .replace(/\n?```\s*$/gm, "") // closing fence
        .trim();

      // Find all '{' positions and scan from end to find last valid JSON with "episodes"
      let jsonStr: string | null = null;
      let scanIdx = cleaned.length - 1;
      while (scanIdx >= 0) {
        const braceIdx = cleaned.lastIndexOf("{", scanIdx);
        if (braceIdx === -1) {
          break;
        }
        scanIdx = braceIdx - 1;
        const slice = cleaned.slice(braceIdx);
        const match = slice.match(/^\{[\s\S]*\}/);
        if (!match) {
          continue;
        }
        const candidate = match[0].replace(/,\s*([\]}])/g, "$1"); // trailing commas
        try {
          const parsed = JSON.parse(candidate) as Record<string, unknown>;
          if (Array.isArray(parsed["episodes"])) {
            jsonStr = candidate;
            break;
          }
        } catch {
          // try next position
        }
      }

      if (!jsonStr) {
        return [];
      }

      const parsed = JSON.parse(jsonStr) as { episodes?: EncodedEpisode[] };
      const episodes: EncodedEpisode[] = (parsed.episodes ?? []).filter(
        (e: EncodedEpisode) => e.importance >= this.config.importanceThreshold,
      );

      return episodes;
    } catch (error) {
      console.error("[EpisodeEncoder] Error encoding conversation:", error);
      return [];
    }
  }

  async generateEmbedding(text: string): Promise<Float32Array> {
    // Use fetch directly to avoid OpenAI client's automatic base64 encoding,
    // which local servers (sentence-transformers) don't support.
    const baseURL = this.config.embeddingBaseUrl || "https://api.openai.com/v1";
    const url = baseURL.replace(/\/$/, "") + "/embeddings";

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.embeddingModel,
        input: text,
        encoding_format: "float",
      }),
    });

    if (!resp.ok) {
      throw new Error(`Embedding API error ${resp.status}: ${await resp.text()}`);
    }

    const json = (await resp.json()) as { data: Array<{ embedding: number[] }> };
    return new Float32Array(json.data[0].embedding);
  }
}

/**
 * Factory: create an EpisodeEncoder from OpenClaw agent config.
 * Reads API key from the openai provider config, episodic model from memorySearch.episodic.
 */
export function createEpisodeEncoder(cfg: OpenClawConfig, agentId: string): EpisodeEncoder {
  const agentCfg = resolveAgentConfig(cfg, agentId);
  const memSearch = agentCfg?.memorySearch ?? cfg.agents?.defaults?.memorySearch;
  const episodicCfg = (
    memSearch as { episodic?: { encoderModel?: string; importanceThreshold?: number } } | undefined
  )?.episodic;

  // Try to get OpenAI API key + baseUrl from provider config (plain string only; SecretRef requires runtime resolution)
  const openaiProvider = cfg.models?.providers?.["openai"] as
    | { apiKey?: unknown; baseUrl?: string }
    | undefined;
  const rawKey = openaiProvider?.apiKey;
  const apiKey = normalizeSecretInputString(rawKey) ?? undefined;
  const chatBaseUrl = openaiProvider?.baseUrl;

  // embeddingBaseUrl: use EMBEDDING_BASE_URL env var if set, otherwise same as chatBaseUrl
  const embeddingBaseUrl = process.env["EMBEDDING_BASE_URL"] ?? chatBaseUrl;

  return new EpisodeEncoder({
    model: episodicCfg?.encoderModel,
    importanceThreshold: episodicCfg?.importanceThreshold,
    apiKey,
    chatBaseUrl,
    embeddingBaseUrl,
  });
}
