import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { exportLearningBridgeRun } from "../../learning-bridge/index.js";
import { redactEvent } from "./redaction.js";
import { ResearchEventV1Schema, type ResearchEventV1 } from "./types.js";
import { createEventsWriter, isLearningBridgeEnabled } from "./writer.js";

export type ResearchRunContext = {
  runId: string;
  sessionId: string;
  sessionKey?: string;
  agentId: string;
  emit: (
    event: Omit<ResearchEventV1, "v" | "ts" | "runId" | "sessionId" | "sessionKey" | "agentId">,
  ) => Promise<void>;
  close: () => Promise<void>;
  enabled: boolean;
};

function toEvent(
  ctx: ResearchRunContext,
  event: Omit<ResearchEventV1, "v" | "ts" | "runId" | "sessionId" | "sessionKey" | "agentId">,
): ResearchEventV1 {
  return {
    v: 1,
    ts: Date.now(),
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    sessionKey: ctx.sessionKey,
    agentId: ctx.agentId,
    ...event,
  } as ResearchEventV1;
}

export function createResearchRunContext(params: {
  cfg?: OpenClawConfig;
  runId: string;
  sessionId: string;
  sessionKey?: string;
  agentId: string;
}): ResearchRunContext {
  const writer = createEventsWriter({
    cfg: params.cfg,
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });

  const learningBridgeBuffer: ResearchEventV1[] | null = isLearningBridgeEnabled(params.cfg)
    ? []
    : null;

  const ctx: ResearchRunContext = {
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    enabled: writer.enabled,
    emit: async (event) => {
      if (!writer.enabled) {
        return;
      }
      const e = toEvent(ctx, event);
      await writer.emit(e);
      if (learningBridgeBuffer) {
        learningBridgeBuffer.push(redactEvent(ResearchEventV1Schema.parse(e)));
      }
    },
    close: async () => {
      await writer.close();
      if (learningBridgeBuffer && learningBridgeBuffer.length > 0) {
        await exportLearningBridgeRun({
          cfg: params.cfg,
          runId: params.runId,
          sessionId: params.sessionId,
          agentId: params.agentId,
          events: learningBridgeBuffer,
        });
      }
    },
  };
  return ctx;
}

export async function emitStandaloneResearchEvent(params: {
  cfg?: OpenClawConfig;
  runId: string;
  sessionId: string;
  sessionKey?: string;
  agentId: string;
  event: Omit<ResearchEventV1, "v" | "ts" | "runId" | "sessionId" | "sessionKey" | "agentId">;
}): Promise<void> {
  const writer = createEventsWriter({
    cfg: params.cfg,
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  if (!writer.enabled) {
    return;
  }
  await writer.emit(
    toEvent(
      {
        runId: params.runId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        enabled: true,
        emit: async () => {},
        close: async () => {},
      },
      params.event,
    ),
  );
  await writer.close();
}
