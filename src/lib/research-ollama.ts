/**
 * Ollama LLM integration for research chatbot.
 * Integrates with local Ollama instance on your PC.
 * Uses the existing models-config setup from src/agents/models-config.providers.ts
 */

import type { ResearchChatSession } from "./research-chatbot.js";

const OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";

export interface ResearchLlmOptions {
  model?: string; // e.g., "mistral-8b", "llama2", "neural-chat"
  temperature?: number; // 0.0 to 1.0, default 0.7
  topP?: number; // 0.0 to 1.0, default 0.9
  topK?: number; // 1 to 100, default 40
  stream?: boolean; // Default: false
  systemPrompt?: string;
}

/**
 * Generate research suggestions using local Ollama instance.
 * This runs LLM inference on your PC—no external API calls.
 */
export async function generateOllamaResearchResponse(
  userMessage: string,
  session: ResearchChatSession,
  options: ResearchLlmOptions = {},
): Promise<string> {
  const { model = "mistral-8b", temperature = 0.7, topP = 0.9, stream = false } = options;

  // Build system prompt for research context
  const systemPrompt = options.systemPrompt || buildResearchSystemPrompt(session);

  // Build conversation history
  const messages = buildMessageHistory(session, userMessage);

  // Add system message at the beginning
  messages.unshift({ role: "system", content: systemPrompt });

  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        top_p: topP,
        stream,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as OpenAiChatCompletion;
    const assistantMessage = data.choices[0]?.message?.content;

    if (!assistantMessage) {
      throw new Error("No content in Ollama response");
    }

    return assistantMessage;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.warn(`Ollama generation failed: ${errorMsg}`);
    // Fall back to heuristic response
    return generateHeuristicResponse(userMessage, session);
  }
}

/**
 * Generate streaming research response from Ollama.
 * Yields chunks as they arrive from the model.
 */
export async function* generateOllamaResearchResponseStream(
  userMessage: string,
  session: ResearchChatSession,
  options: ResearchLlmOptions = {},
): AsyncGenerator<string, void, unknown> {
  const { model = "mistral-8b", temperature = 0.7, topP = 0.9 } = options;

  const systemPrompt = options.systemPrompt || buildResearchSystemPrompt(session);
  const messages = buildMessageHistory(session, userMessage);

  // Add system message at the beginning
  messages.unshift({ role: "system", content: systemPrompt });

  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        top_p: topP,
        stream: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama streaming failed: ${response.status}`);
    }

    if (!response.body) {
      throw new Error("No response body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const jsonStr = line.slice(6);
          if (jsonStr === "[DONE]") {
            continue;
          }

          try {
            const chunk = JSON.parse(jsonStr) as StreamChunk;
            const content = chunk.choices[0]?.delta?.content;
            if (content) {
              yield content;
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.warn(`Ollama streaming failed: ${errorMsg}, falling back to heuristic`);
    yield generateHeuristicResponse(userMessage, session);
  }
}

/**
 * Check if Ollama is running and accessible.
 */
export async function isOllamaAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL.replace("/v1", "")}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get list of available models from local Ollama instance.
 */
export async function getAvailableOllamaModels(): Promise<string[]> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL.replace("/v1", "")}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as { models: Array<{ name: string }> };
    return data.models?.map((m) => m.name) || [];
  } catch {
    return [];
  }
}

// ============================================================
// Internal Helpers
// ============================================================

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenAiChatCompletion {
  choices: Array<{
    message?: {
      content: string;
    };
  }>;
}

interface StreamChunk {
  choices: Array<{
    delta?: {
      content?: string;
    };
  }>;
}

function buildResearchSystemPrompt(session: ResearchChatSession): string {
  const docStr = session.workingDoc
    ? `
Current Document:
Title: ${session.workingDoc.title || "Untitled"}
Sections: ${session.workingDoc.sections?.length || 0}
${
  session.workingDoc.sections
    ?.slice(0, 3)
    .map((s) => `  - ${s.title || "Section"}: ${s.text.slice(0, 100)}...`)
    .join("\n") || ""
}
    `
    : "";

  return `You are a research assistant helping to organize and structure research documents.
Your role is to:
1. Help users organize their research into coherent sections
2. Suggest logical groupings and hierarchies
3. Identify gaps in the research
4. Propose clarifying questions
5. Format research for export (Markdown, JSON)

Be concise and actionable in your suggestions.
${docStr}`;
}

function buildMessageHistory(session: ResearchChatSession, newUserMessage: string): Message[] {
  const messages: Message[] = [];

  // Add recent turn history (last 5)
  const recentTurns = session.turns.slice(-5);
  for (const turn of recentTurns) {
    messages.push({
      role: turn.role === "user" ? "user" : "assistant",
      content: turn.content,
    });
  }

  // Add current user message
  messages.push({
    role: "user",
    content: newUserMessage,
  });

  return messages;
}

/**
 * Fallback heuristic response when Ollama is unavailable.
 * Matches the Phase 1 behavior.
 */
function generateHeuristicResponse(userMessage: string, session: ResearchChatSession): string {
  const lower = userMessage.toLowerCase();

  if (lower.includes("summarize") || lower.includes("summary") || lower.includes("overview")) {
    const sections = session.workingDoc?.sections || [];
    if (sections.length === 0) {
      return "The research document is still empty. Add some notes first with specific observations or findings.";
    }
    return `Current document has ${sections.length} sections:\n${sections
      .map((s) => `- **${s.title || "Section"}**: ${s.text.slice(0, 50)}...`)
      .join("\n")}`;
  }

  if (lower.includes("organize") || lower.includes("structure")) {
    return "I'd suggest grouping your notes by theme or time period. Would you like to reorganize the sections?";
  }

  if (lower.includes("gap") || lower.includes("missing")) {
    return "Consider adding sections for: methodology, context, implications, and next steps.";
  }

  if (lower.includes("question")) {
    return "What specific aspect would you like to explore deeper? I can help refine the research direction.";
  }

  return `I understand you want to: "${userMessage}". Please be more specific about what you'd like to do with your research.`;
}
