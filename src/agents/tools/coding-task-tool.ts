import { Type } from "@sinclair/typebox";

import type { ClawdbrainConfig } from "../../config/config.js";
import { buildCodingTaskSdkOptions } from "../claude-agent-sdk/coding-task-options.js";
import { extractTextFromClaudeAgentSdkEvent } from "../claude-agent-sdk/extract.js";
import { loadClaudeAgentSdk } from "../claude-agent-sdk/sdk.js";
import type { AnyAgentTool } from "./common.js";
import { readStringParam } from "./common.js";

const CodingTaskToolSchema = Type.Object({
  task: Type.String({
    description:
      "REQUIRED. A coding task to run via Claude Agent SDK (Claude Code-style; capabilities gated by tools.codingTask).",
  }),
});

const DEFAULT_MAX_EXTRACTED_CHARS = 80_000;

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return !!value && typeof value === "object" && Symbol.asyncIterator in value;
}

async function coerceAsyncIterable(value: unknown): Promise<AsyncIterable<unknown>> {
  if (isAsyncIterable(value)) return value;
  if (value instanceof Promise) {
    const awaited = await value;
    if (isAsyncIterable(awaited)) return awaited;
  }
  throw new Error("Claude Agent SDK query did not return an async iterable");
}

function resolveCodingTaskEnabled(cfg?: ClawdbrainConfig): boolean {
  return cfg?.tools?.codingTask?.enabled === true;
}

export function createCodingTaskTool(opts?: {
  config?: ClawdbrainConfig;
  workspaceDir?: string;
}): AnyAgentTool {
  return {
    label: "Coding",
    name: "coding_task",
    description:
      "Run a Claude Code-style coding task via the Claude Agent SDK. " +
      "REQUIRED PARAMETER: task (string). " +
      "Example input: { task: 'Create a function that calculates fibonacci numbers' }. " +
      "Example output: { status: 'completed', result: '...extracted text...', durationMs: 5000 }.",
    parameters: CodingTaskToolSchema,
    execute: async (_toolCallId, args) => {
      const cfg = opts?.config;
      if (!resolveCodingTaskEnabled(cfg)) {
        return {
          content: [
            {
              type: "text",
              text: "coding_task is disabled. Enable it with tools.codingTask.enabled=true.",
            },
          ],
          details: { status: "disabled" },
        };
      }

      const params = args as Record<string, unknown>;
      const task = readStringParam(params, "task", { required: true });

      const cwd = opts?.workspaceDir?.trim() || process.cwd();
      const startedAt = Date.now();

      let sdk;
      try {
        sdk = await loadClaudeAgentSdk();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text:
                "Claude Agent SDK is not available. Install @anthropic-ai/claude-agent-sdk " +
                "and ensure Claude Code is configured on this machine.\n\n" +
                `Error: ${message}`,
            },
          ],
          details: {
            status: "error",
            error: "sdk_unavailable",
            message,
          },
        };
      }

      let events = 0;
      let truncated = false;
      const chunks: string[] = [];
      let extractedChars = 0;
      let resultText: string | undefined;

      const sdkResolved = buildCodingTaskSdkOptions({ config: cfg, cwd });

      try {
        const stream = await coerceAsyncIterable(
          sdk.query({
            prompt: task,
            options: sdkResolved.options,
          }),
        );

        for await (const event of stream) {
          events += 1;

          // Prefer the final result message when present.
          if (
            typeof event === "object" &&
            event !== null &&
            "type" in event &&
            (event as { type?: unknown }).type === "result" &&
            "result" in event &&
            typeof (event as { result?: unknown }).result === "string"
          ) {
            resultText = (event as { result: string }).result;
            break;
          }

          const text = extractTextFromClaudeAgentSdkEvent(event);
          if (!text) continue;

          const trimmed = text.trimEnd();
          if (!trimmed) continue;

          // Avoid obvious duplication when SDK emits both deltas and full messages.
          const last = chunks.at(-1);
          if (last && (last === trimmed || last.endsWith(trimmed))) continue;

          chunks.push(trimmed);
          extractedChars += trimmed.length;
          if (extractedChars >= DEFAULT_MAX_EXTRACTED_CHARS) {
            truncated = true;
            break;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `coding_task failed: ${message}` }],
          details: {
            status: "error",
            error: "run_failed",
            message,
            events,
            durationMs: Date.now() - startedAt,
          },
        };
      }

      const text = (resultText ?? chunks.join("\n\n")).trim();
      if (!text) {
        return {
          content: [{ type: "text", text: "coding_task completed but returned no text output." }],
          details: {
            status: "error",
            error: "no_output",
            events,
            durationMs: Date.now() - startedAt,
          },
        };
      }

      const suffix = truncated ? "\n\n[Output truncated]" : "";
      return {
        content: [{ type: "text", text: `${text}${suffix}` }],
        details: {
          status: "ok",
          events,
          extractedChars,
          truncated,
          cwd,
          permissionMode: sdkResolved.permissionMode,
          toolPreset: sdkResolved.toolPreset,
          allowedTools: sdkResolved.allowedTools,
          disallowedTools: sdkResolved.disallowedTools,
          durationMs: Date.now() - startedAt,
        },
      };
    },
  };
}
