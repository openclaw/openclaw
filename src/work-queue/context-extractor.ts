import type { WorkItem } from "./types.js";

export type WorkItemCarryoverContext = {
  summary?: string;
  outputs?: Record<string, unknown>;
  workstreamNotes?: string;
  keyFindings?: string[];
  artifacts?: Array<{ type: string; path?: string; description?: string }>;
  extractedAt: string;
};

export interface WorkContextExtractor {
  extract(params: {
    sessionKey: string;
    item: WorkItem;
    runResult: { status: "ok" | "error"; error?: string };
    previousContext?: WorkItemCarryoverContext;
  }): Promise<WorkItemCarryoverContext>;
}

/**
 * Default context extractor that reads the final assistant reply from the
 * completed session transcript. Fast, no LLM call.
 */
export class TranscriptContextExtractor implements WorkContextExtractor {
  private readReply: (params: {
    sessionKey: string;
    limit?: number;
  }) => Promise<string | undefined>;

  constructor(opts: {
    readLatestAssistantReply: (params: {
      sessionKey: string;
      limit?: number;
    }) => Promise<string | undefined>;
  }) {
    this.readReply = opts.readLatestAssistantReply;
  }

  async extract(params: {
    sessionKey: string;
    item: WorkItem;
    runResult: { status: "ok" | "error"; error?: string };
    previousContext?: WorkItemCarryoverContext;
  }): Promise<WorkItemCarryoverContext> {
    const now = new Date().toISOString();
    if (params.runResult.status === "error") {
      return {
        summary: `Failed: ${params.runResult.error ?? "unknown error"}`,
        extractedAt: now,
      };
    }

    const reply = await this.readReply({
      sessionKey: params.sessionKey,
      limit: 50,
    });

    return {
      summary: reply ? truncate(reply, 2000) : "Session completed (no reply captured)",
      extractedAt: now,
    };
  }
}

/**
 * LLM-based context extractor that spawns a short-lived extraction session
 * to analyze the work session transcript and return structured data.
 * Falls back to TranscriptContextExtractor behavior on failure.
 */
export class LlmContextExtractor implements WorkContextExtractor {
  private callGateway: <T = Record<string, unknown>>(opts: {
    method: string;
    params?: unknown;
    timeoutMs?: number;
  }) => Promise<T>;
  private readFullTranscript: (params: {
    sessionKey: string;
    limit?: number;
  }) => Promise<unknown[]>;
  private log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug: (msg: string) => void;
  };

  constructor(opts: {
    callGateway: <T = Record<string, unknown>>(opts: {
      method: string;
      params?: unknown;
      timeoutMs?: number;
    }) => Promise<T>;
    readFullTranscript: (params: { sessionKey: string; limit?: number }) => Promise<unknown[]>;
    log: {
      info: (msg: string) => void;
      warn: (msg: string) => void;
      error: (msg: string) => void;
      debug: (msg: string) => void;
    };
  }) {
    this.callGateway = opts.callGateway;
    this.readFullTranscript = opts.readFullTranscript;
    this.log = opts.log;
  }

  async extract(params: {
    sessionKey: string;
    item: WorkItem;
    runResult: { status: "ok" | "error"; error?: string };
    previousContext?: WorkItemCarryoverContext;
  }): Promise<WorkItemCarryoverContext> {
    const now = new Date().toISOString();

    // For error runs, skip LLM extraction.
    if (params.runResult.status === "error") {
      return {
        summary: `Failed: ${params.runResult.error ?? "unknown error"}`,
        extractedAt: now,
      };
    }

    try {
      // Read the full transcript from the session.
      const transcript = await this.readFullTranscript({
        sessionKey: params.sessionKey,
        limit: 500,
      });

      if (!transcript || transcript.length === 0) {
        return { summary: "Session completed (no transcript)", extractedAt: now };
      }

      // Spawn a short extraction session.
      const extractionPrompt = this.buildExtractionPrompt(transcript);
      const sessionKey = `extract:${params.item.id}:${Date.now()}`;

      const spawnResult = await this.callGateway<{ runId: string }>({
        method: "agent",
        params: {
          message: extractionPrompt,
          sessionKey,
          deliver: false,
          lane: "worker",
          timeout: 30,
          label: `Extract: ${params.item.title}`,
        },
        timeoutMs: 5_000,
      });

      const runId = spawnResult?.runId;
      if (!runId) throw new Error("no runId from extraction session");

      // Wait for extraction to complete.
      await this.callGateway({
        method: "agent.wait",
        params: { runId, timeoutMs: 30_000 },
        timeoutMs: 35_000,
      });

      // Read the extraction response.
      const history = await this.callGateway<{
        messages?: Array<{ role: string; content: string }>;
      }>({
        method: "chat.history",
        params: { sessionKey, limit: 10 },
        timeoutMs: 5_000,
      });

      // Clean up extraction session.
      await this.callGateway({
        method: "sessions.delete",
        params: { key: sessionKey, deleteTranscript: true },
        timeoutMs: 5_000,
      }).catch(() => {});

      // Parse the JSON response from the assistant.
      const assistantMsg = history?.messages?.find((m) => m.role === "assistant");
      if (assistantMsg?.content) {
        const parsed = this.parseExtractionResponse(assistantMsg.content);
        if (parsed) {
          return { ...parsed, extractedAt: now };
        }
      }

      // Fallback: use last message from transcript as summary.
      return this.fallbackExtract(transcript, now);
    } catch (err) {
      this.log.debug(`LLM extraction failed, falling back: ${String(err)}`);
      // Fallback: try reading transcript for a simple summary.
      try {
        const transcript = await this.readFullTranscript({
          sessionKey: params.sessionKey,
          limit: 50,
        });
        return this.fallbackExtract(transcript, now);
      } catch {
        return { summary: "Session completed (extraction failed)", extractedAt: now };
      }
    }
  }

  private buildExtractionPrompt(transcript: unknown[]): string {
    const transcriptStr = JSON.stringify(transcript).slice(0, 8000);
    return `Analyze this work session transcript and return a JSON object with these fields:
- summary: A 1-2 sentence summary of what was accomplished
- outputs: A key-value object of important outputs/results
- keyFindings: An array of key findings or decisions made
- artifacts: An array of objects with {type, path, description} for any files created/modified

Respond ONLY with valid JSON wrapped in a code block.

Transcript:
${transcriptStr}`;
  }

  private parseExtractionResponse(
    content: string,
  ): Omit<WorkItemCarryoverContext, "extractedAt"> | null {
    try {
      // Extract JSON from code blocks or raw JSON.
      const jsonMatch =
        content.match(/```(?:json)?\s*([\s\S]*?)```/) ?? content.match(/(\{[\s\S]*\})/);
      if (!jsonMatch?.[1]) return null;

      const parsed = JSON.parse(jsonMatch[1]) as {
        summary?: string;
        outputs?: Record<string, unknown>;
        keyFindings?: string[];
        artifacts?: Array<{ type: string; path?: string; description?: string }>;
      };

      return {
        summary: parsed.summary,
        outputs: parsed.outputs,
        keyFindings: parsed.keyFindings,
        artifacts: parsed.artifacts,
      };
    } catch {
      return null;
    }
  }

  private fallbackExtract(transcript: unknown[], now: string): WorkItemCarryoverContext {
    // Find the last assistant message for a summary.
    const messages = transcript as Array<{ role?: string; content?: string }>;
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    const summary = lastAssistant?.content
      ? truncate(lastAssistant.content, 2000)
      : "Session completed (no reply captured)";
    return { summary, extractedAt: now };
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 3)}...`;
}
