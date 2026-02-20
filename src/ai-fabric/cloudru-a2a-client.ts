/**
 * Cloud.ru AI Fabric — A2A Client
 *
 * Agent-to-Agent (A2A) communication client for Cloud.ru AI Agents.
 * Sends messages to Cloud.ru agents via their A2A endpoints and
 * returns text responses.
 *
 * Standalone module — only imports from ai-fabric/ and infra/.
 *
 * @see https://google.github.io/A2A/
 */

import type { CloudruAuthConfig } from "./types.js";
import { computeBackoff, sleepWithAbort } from "../infra/backoff.js";
import { resolveFetch } from "../infra/fetch.js";
import { CloudruTokenProvider, type CloudruAuthOptions } from "./cloudru-auth.js";
import { CLOUDRU_A2A_POLL_POLICY, CLOUDRU_DEFAULT_TIMEOUT_MS } from "./constants.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type A2AClientConfig = {
  /** IAM credentials for authenticating with Cloud.ru. */
  auth: CloudruAuthConfig;
  /** Override IAM token URL (for testing). */
  iamUrl?: string;
  /** HTTP request timeout in ms (default: 30s). */
  timeoutMs?: number;
  /** Custom fetch implementation (for testing). */
  fetchImpl?: typeof fetch;
};

export type A2AMessagePart = {
  kind?: "text";
  type?: "text";
  text: string;
};

export type A2AMessage = {
  role: "user" | "agent";
  parts: A2AMessagePart[];
};

export type A2ASendParams = {
  /** A2A endpoint URL of the target agent. */
  endpoint: string;
  /** Message text to send. */
  message: string;
  /** Optional session/conversation ID for multi-turn. */
  sessionId?: string;
};

export type A2ATaskResponse = {
  id: string;
  sessionId?: string;
  contextId?: string;
  kind?: "task";
  status: {
    state: "completed" | "failed" | "working" | "input-required";
    message?: A2AMessage;
  };
  artifacts?: Array<{
    artifactId?: string;
    name?: string;
    parts: A2AMessagePart[];
  }>;
};

export type A2ASendResult = {
  /** Whether the request succeeded. */
  ok: boolean;
  /** Extracted text response from the agent. */
  text: string;
  /** Task ID for follow-up. */
  taskId?: string;
  /** Session ID for multi-turn conversations. */
  sessionId?: string;
};

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class A2AError extends Error {
  status?: number;
  code?: string;

  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "A2AError";
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class CloudruA2AClient {
  private readonly tokenProvider: CloudruTokenProvider;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: A2AClientConfig) {
    this.timeoutMs = config.timeoutMs ?? CLOUDRU_DEFAULT_TIMEOUT_MS;
    this.fetchImpl = resolveFetch(config.fetchImpl) ?? fetch;

    const authOpts: CloudruAuthOptions = {
      iamUrl: config.iamUrl,
      timeoutMs: this.timeoutMs,
      fetchImpl: config.fetchImpl,
    };
    this.tokenProvider = new CloudruTokenProvider(config.auth, authOpts);
  }

  /**
   * Send a message to a Cloud.ru AI Agent via A2A protocol.
   *
   * Uses the JSON-RPC `message/send` method (A2A v0.3.0).
   */
  async sendMessage(params: A2ASendParams): Promise<A2ASendResult> {
    const { endpoint, message, sessionId } = params;
    const deadline = Date.now() + this.timeoutMs;

    const token = await this.tokenProvider.getToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const body = {
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "message/send",
        params: {
          ...(sessionId ? { contextId: sessionId } : {}),
          message: {
            messageId: crypto.randomUUID(),
            role: "user" as const,
            parts: [{ kind: "text" as const, text: message }],
            kind: "message" as const,
          },
        },
      };

      const res = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new A2AError(
          `A2A request to ${endpoint} failed (${res.status}): ${text || "no details"}`,
          res.status,
        );
      }

      const json = (await res.json()) as {
        result?: A2ATaskResponse;
        error?: { code: number; message: string };
      };

      if (json.error) {
        throw new A2AError(
          `A2A RPC error: ${json.error.message}`,
          undefined,
          String(json.error.code),
        );
      }

      if (!json.result) {
        throw new A2AError("A2A response missing result");
      }

      let task = json.result;
      if (task.status.state === "working" && task.id) {
        task = await this.pollTask(task.id, endpoint, deadline, controller.signal);
      }

      return {
        ok: true,
        text: extractResponseText(task),
        taskId: task.id,
        sessionId: task.contextId ?? task.sessionId,
      };
    } catch (err) {
      if (err instanceof A2AError) {
        throw err;
      }
      const errName = (err as Error).name;
      const errMsg = (err as Error).message;
      if (errName === "AbortError" || errMsg === "aborted") {
        throw new A2AError(`A2A request to ${endpoint} timed out after ${this.timeoutMs}ms`);
      }
      throw new A2AError(`A2A request failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Poll `tasks/get` until the task reaches a terminal state.
   * Used for agent-system orchestrators that return `working` from `message/send`.
   */
  private async pollTask(
    taskId: string,
    endpoint: string,
    deadline: number,
    signal: AbortSignal,
  ): Promise<A2ATaskResponse> {
    for (let attempt = 1; ; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new A2AError(`A2A task ${taskId} polling timed out after ${this.timeoutMs}ms`);
      }

      const delayMs = computeBackoff(CLOUDRU_A2A_POLL_POLICY, attempt);
      await sleepWithAbort(Math.min(delayMs, remaining), signal);

      const token = await this.tokenProvider.getToken();
      const body = {
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "tasks/get",
        params: { id: taskId },
      };

      const res = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new A2AError(
          `A2A tasks/get failed (${res.status}): ${text || "no details"}`,
          res.status,
        );
      }

      const json = (await res.json()) as {
        result?: A2ATaskResponse;
        error?: { code: number; message: string };
      };

      if (json.error) {
        throw new A2AError(
          `A2A tasks/get RPC error: ${json.error.message}`,
          undefined,
          String(json.error.code),
        );
      }

      if (!json.result) {
        throw new A2AError("A2A tasks/get response missing result");
      }

      const { state } = json.result.status;
      if (state === "completed" || state === "failed" || state === "input-required") {
        return json.result;
      }
    }
  }

  /** Clear the auth token cache (for tests or forced re-auth). */
  clearAuthCache(): void {
    this.tokenProvider.clearCache();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractResponseText(task: A2ATaskResponse): string {
  // Try status message first
  if (task.status.message?.parts?.length) {
    const texts = task.status.message.parts.filter((p) => p.text).map((p) => p.text);
    if (texts.length > 0) {
      return texts.join("\n");
    }
  }

  // Fall back to artifacts — prefer the "result" artifact, then any text part
  if (task.artifacts?.length) {
    const resultArtifact = task.artifacts.find((a) => a.name === "result");
    if (resultArtifact) {
      const texts = resultArtifact.parts.filter((p) => p.text).map((p) => p.text);
      if (texts.length > 0) {
        return texts.join("\n");
      }
    }
    const texts = task.artifacts
      .flatMap((a) => a.parts)
      .filter((p) => p.text)
      .map((p) => p.text);
    if (texts.length > 0) {
      return texts.join("\n");
    }
  }

  if (task.status.state === "failed") {
    return "Agent returned an error with no details.";
  }
  if (task.status.state === "input-required") {
    return "Agent requires additional input but provided no prompt.";
  }
  return "Agent completed but returned no text response.";
}
