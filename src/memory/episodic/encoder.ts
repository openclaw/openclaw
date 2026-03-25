import OpenAI from "openai";
import { resolveAgentConfig } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/config.js";
import { normalizeSecretInputString } from "../../config/types.secrets.js";
import type { EncodedEpisode } from "./types.js";

const ENCODER_SYSTEM_PROMPT = `你是一个情节记忆编码器。从以下对话中提取值得记住的情节。

## 提取规则
1. 只提取有长期价值的信息（决策、偏好、承诺、重要发现）
2. 忽略纯操作性内容（"帮我搜索X"→不记，但"搜索后发现X很重要"→记）
3. 情绪强烈的互动优先提取（惊喜、沮丧、兴奋）
4. 用户的明确表态/偏好必须提取

## 输出格式（JSON）
{
  "episodes": [
    {
      "summary": "一句话描述发生了什么",
      "details": "关键细节，保留具体数据/数字",
      "importance": 0.0到1.0之间的数值,
      "emotional_valence": -1.0到1.0之间的数值（负面到正面）,
      "emotional_arousal": 0.0到1.0之间的数值（平静到激动）,
      "topic_tags": ["tag1", "tag2"],
      "participants": ["用户", "助手"]
    }
  ],
  "no_episodes_reason": "如果没有值得记录的情节，说明原因"
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

  async encode(conversationText: string, _agentId: string = "default"): Promise<EncodedEpisode[]> {
    if (conversationText.length < this.config.minConversationLength) {
      return [];
    }

    try {
      const response = await this.chatClient.chat.completions.create({
        model: this.config.model,
        messages: [
          { role: "system", content: ENCODER_SYSTEM_PROMPT },
          { role: "user", content: `以下是对话内容，请提取情节记忆：\n\n${conversationText}` },
        ],
        temperature: 0.3,
        max_tokens: 2048,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        return [];
      }

      // Robustly extract JSON: strip markdown fences, then find outermost {...}
      const cleaned = content
        .replace(/^```(?:json)?\s*\n?/gm, "") // opening fence
        .replace(/\n?```\s*$/gm, "") // closing fence
        .trim();

      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return [];
      }

      // Sanitize common LLM JSON issues: trailing commas, control chars
      const jsonStr = jsonMatch[0].replace(/,\s*([\]}])/g, "$1"); // trailing commas

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

  // Try to get OpenAI API key from provider config (plain string only; SecretRef requires runtime resolution)
  const rawKey = (cfg.models?.providers?.["openai"] as { apiKey?: unknown } | undefined)?.apiKey;
  const apiKey = normalizeSecretInputString(rawKey) ?? undefined;

  return new EpisodeEncoder({
    model: episodicCfg?.encoderModel,
    importanceThreshold: episodicCfg?.importanceThreshold,
    apiKey,
  });
}
