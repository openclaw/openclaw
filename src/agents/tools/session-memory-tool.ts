import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import {
  isSessionSanitizationToolingAvailable,
  recallSessionMemory,
  signalSessionMemory,
} from "../../memory/session-sanitization/service.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const SessionMemoryRecallSchema = Type.Object({
  query: Type.String(),
});

const SessionMemorySignalSchema = Type.Object({
  query: Type.String(),
  limit: Type.Optional(Type.Number()),
});

type ToolContext = {
  cfg: OpenClawConfig;
  agentId: string;
  sessionId: string;
};

function resolveToolContext(options: {
  config?: OpenClawConfig;
  agentId: string;
  sessionId?: string;
}): ToolContext | null {
  const cfg = options.config;
  const sessionId = options.sessionId?.trim();
  if (!cfg || !sessionId) {
    return null;
  }
  if (
    !isSessionSanitizationToolingAvailable({
      cfg,
      agentId: options.agentId,
      sessionId,
    })
  ) {
    return null;
  }
  return {
    cfg,
    agentId: options.agentId,
    sessionId,
  };
}

export function createSessionMemoryRecallTool(options: {
  config?: OpenClawConfig;
  agentId: string;
  sessionId?: string;
}): AnyAgentTool | null {
  const ctx = resolveToolContext(options);
  if (!ctx) {
    return null;
  }
  return {
    label: "Session Memory Recall",
    name: "session_memory_recall",
    description:
      "Current-session transcript-derived recall only. Searches sanitized session-memory sidecars for this active session and returns result + source + confidence. Use this for transcript-origin recall; medium/low confidence should be surfaced explicitly.",
    parameters: SessionMemoryRecallSchema,
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query", { required: true });
      return jsonResult(
        await recallSessionMemory({
          cfg: ctx.cfg,
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          query,
          helperDeps: { lane: "background:session-memory-recall" },
        }),
      );
    },
  };
}

export function createSessionMemorySignalTool(options: {
  config?: OpenClawConfig;
  agentId: string;
  sessionId?: string;
}): AnyAgentTool | null {
  const ctx = resolveToolContext(options);
  if (!ctx) {
    return null;
  }
  return {
    label: "Session Memory Signal",
    name: "session_memory_signal",
    description:
      "Current-session transcript-derived signal extraction only. Returns compact relevant items from sanitized session-memory sidecars for noisy transcript-heavy sessions. This is not a raw transcript inspection tool.",
    parameters: SessionMemorySignalSchema,
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query", { required: true });
      const limit = readNumberParam(params, "limit", { integer: true });
      return jsonResult(
        await signalSessionMemory({
          cfg: ctx.cfg,
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          query,
          limit,
          helperDeps: { lane: "background:session-memory-signal" },
        }),
      );
    },
  };
}
