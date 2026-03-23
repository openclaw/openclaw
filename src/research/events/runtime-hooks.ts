import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ResearchEventV1 } from "./types.js";
import { createEventsWriter } from "./writer.js";

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
      await writer.emit(toEvent(ctx, event));
    },
    close: async () => {
      await writer.close();
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
