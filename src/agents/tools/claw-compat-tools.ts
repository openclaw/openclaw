import { setTimeout as sleepTimeout } from "node:timers/promises";
import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { listCoreToolSections } from "../tool-catalog.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";

function readNumberParam(input: Record<string, unknown>, key: string): number | undefined {
  const raw = input[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function readRecordParam(input: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const raw = input[key];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  return raw as Record<string, unknown>;
}

function getByPath(root: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = root;
  for (const segment of path.split(".").filter(Boolean)) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

export function createAskUserQuestionCompatTool(): AnyAgentTool {
  return {
    name: "ask_user_question",
    label: "ask_user_question",
    description: "Compatibility bridge for claw-code AskUserQuestion tool.",
    parameters: Type.Object(
      {
        question: Type.String(),
        options: Type.Optional(Type.Array(Type.String())),
      },
      { additionalProperties: true },
    ),
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const question = readStringParam(params, "question", { required: true });
      const options = Array.isArray(params.options)
        ? params.options.filter((entry): entry is string => typeof entry === "string")
        : [];
      return jsonResult({
        status: "pending",
        question,
        options,
        note: "question captured; host interaction is handled outside this tool bridge.",
      });
    },
  };
}

export function createSendUserMessageCompatTool(): AnyAgentTool {
  return {
    name: "send_user_message",
    label: "send_user_message",
    description: "Compatibility bridge for claw-code SendUserMessage tool.",
    parameters: Type.Object({ message: Type.String() }, { additionalProperties: true }),
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const message = readStringParam(params, "message", { required: true });
      return jsonResult({ status: "ok", delivered: true, message });
    },
  };
}

export function createEnterPlanModeCompatTool(): AnyAgentTool {
  return {
    name: "enter_plan_mode",
    label: "enter_plan_mode",
    description: "Compatibility bridge for claw-code EnterPlanMode tool.",
    parameters: Type.Object({}, { additionalProperties: true }),
    execute: async () => jsonResult({ status: "ok", mode: "plan" }),
  };
}

export function createExitPlanModeCompatTool(): AnyAgentTool {
  return {
    name: "exit_plan_mode",
    label: "exit_plan_mode",
    description: "Compatibility bridge for claw-code ExitPlanMode tool.",
    parameters: Type.Object({}, { additionalProperties: true }),
    execute: async () => jsonResult({ status: "ok", mode: "normal" }),
  };
}

export function createStructuredOutputCompatTool(): AnyAgentTool {
  return {
    name: "structured_output",
    label: "structured_output",
    description: "Compatibility bridge for claw-code StructuredOutput tool.",
    parameters: Type.Object(
      {
        value: Type.Optional(Type.Unknown()),
        data: Type.Optional(Type.Unknown()),
      },
      { additionalProperties: true },
    ),
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      return jsonResult({
        status: "ok",
        output: params.value ?? params.data ?? params,
      });
    },
  };
}

export function createSleepCompatTool(): AnyAgentTool {
  return {
    name: "sleep",
    label: "sleep",
    description: "Compatibility bridge for claw-code Sleep tool.",
    parameters: Type.Object(
      {
        ms: Type.Optional(Type.Number({ minimum: 0 })),
        seconds: Type.Optional(Type.Number({ minimum: 0 })),
      },
      { additionalProperties: true },
    ),
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const msFromMs = readNumberParam(params, "ms");
      const seconds = readNumberParam(params, "seconds");
      const sleepMs =
        msFromMs !== undefined
          ? Math.max(0, Math.floor(msFromMs))
          : seconds !== undefined
            ? Math.max(0, Math.floor(seconds * 1000))
            : 1000;
      await sleepTimeout(sleepMs);
      return jsonResult({ status: "ok", sleptMs: sleepMs });
    },
  };
}

export function createToolSearchCompatTool(): AnyAgentTool {
  return {
    name: "tool_search",
    label: "tool_search",
    description: "Compatibility bridge for claw-code ToolSearch tool.",
    parameters: Type.Object(
      {
        query: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
      },
      { additionalProperties: true },
    ),
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const query = (readStringParam(params, "query") ?? "").trim().toLowerCase();
      const limit = Math.max(1, Math.min(100, Math.floor(readNumberParam(params, "limit") ?? 20)));
      const entries = listCoreToolSections().flatMap((section) =>
        section.tools.map((tool) => ({
          id: tool.id,
          label: tool.label,
          description: tool.description,
          section: section.id,
        })),
      );
      const filtered = query
        ? entries.filter(
            (entry) =>
              entry.id.toLowerCase().includes(query) ||
              entry.label.toLowerCase().includes(query) ||
              entry.description.toLowerCase().includes(query),
          )
        : entries;
      return jsonResult({
        status: "ok",
        query,
        total: filtered.length,
        tools: filtered.slice(0, limit),
      });
    },
  };
}

export function createTodoWriteCompatTool(): AnyAgentTool {
  return {
    name: "todo_write",
    label: "todo_write",
    description: "Compatibility bridge for claw-code TodoWrite tool.",
    parameters: Type.Object(
      {
        text: Type.Optional(Type.String()),
        items: Type.Optional(Type.Array(Type.String())),
        todos: Type.Optional(Type.Array(Type.Unknown())),
      },
      { additionalProperties: true },
    ),
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const text = readStringParam(params, "text");
      const itemsRaw = Array.isArray(params.items)
        ? params.items.filter((entry): entry is string => typeof entry === "string")
        : [];
      const todosRaw = Array.isArray(params.todos) ? params.todos : [];
      return jsonResult({
        status: "ok",
        text: text ?? null,
        items: itemsRaw,
        todos: todosRaw,
      });
    },
  };
}

export function createConfigCompatTool(): AnyAgentTool {
  return {
    name: "config_compat",
    label: "config_compat",
    description: "Compatibility bridge for claw-code Config tool.",
    parameters: Type.Object(
      {
        path: Type.Optional(Type.String()),
      },
      { additionalProperties: true },
    ),
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const cfg = loadConfig() as unknown as Record<string, unknown>;
      const path = readStringParam(params, "path");
      const value = path ? getByPath(cfg, path) : cfg;
      return jsonResult({
        status: "ok",
        path: path ?? null,
        value,
      });
    },
  };
}

export function createRemoteTriggerCompatTool(): AnyAgentTool {
  return {
    name: "remote_trigger",
    label: "remote_trigger",
    description: "Compatibility bridge for claw-code RemoteTrigger tool.",
    parameters: Type.Object(
      {
        url: Type.String(),
        method: Type.Optional(Type.String()),
        headers: Type.Optional(Type.Object({}, { additionalProperties: true })),
        body: Type.Optional(Type.Unknown()),
        timeoutMs: Type.Optional(Type.Number({ minimum: 100, maximum: 120000 })),
      },
      { additionalProperties: true },
    ),
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const url = readStringParam(params, "url", { required: true });
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new ToolInputError(`invalid url: ${url}`);
      }
      const method = (readStringParam(params, "method") ?? "POST").toUpperCase();
      const headersRecord = readRecordParam(params, "headers") ?? {};
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(headersRecord)) {
        if (typeof value === "string") {
          headers[key] = value;
        }
      }
      const timeoutMs = Math.max(100, Math.min(120000, Math.floor(readNumberParam(params, "timeoutMs") ?? 10000)));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const bodyValue = params.body;
        const shouldSendBody = !["GET", "HEAD"].includes(method);
        const requestBody =
          shouldSendBody && bodyValue !== undefined ? JSON.stringify(bodyValue) : undefined;
        if (requestBody && !headers["content-type"]) {
          headers["content-type"] = "application/json";
        }
        const response = await fetch(parsed.toString(), {
          method,
          headers,
          body: requestBody,
          signal: controller.signal,
        });
        const text = await response.text();
        return jsonResult({
          status: response.ok ? "ok" : "failed",
          httpStatus: response.status,
          ok: response.ok,
          body: text.slice(0, 8000),
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function createTestingPermissionCompatTool(): AnyAgentTool {
  return {
    name: "testing_permission",
    label: "testing_permission",
    description: "Compatibility bridge for claw-code TestingPermission tool.",
    parameters: Type.Object(
      {
        allow: Type.Optional(Type.Boolean()),
        reason: Type.Optional(Type.String()),
      },
      { additionalProperties: true },
    ),
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      return jsonResult({
        status: "ok",
        allow: params.allow === true,
        reason: readStringParam(params, "reason") ?? null,
      });
    },
  };
}
