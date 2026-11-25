import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  LogbookCardPayload,
  LogbookStatusPayload,
  LogbookTimelinePayload,
} from "./logbook-types.ts";

export function logbookClient(
  request: (method: string, params: unknown) => Promise<unknown>,
): GatewayBrowserClient {
  return { request } as GatewayBrowserClient;
}

export function logbookStatus(
  today: string,
  overrides: Partial<LogbookStatusPayload> = {},
): LogbookStatusPayload {
  return {
    captureEnabled: true,
    capturePaused: false,
    captureIntervalSeconds: 30,
    analysisIntervalMinutes: 15,
    retentionDays: 30,
    pendingFrames: 0,
    analysisRunning: false,
    visionModelSource: "missing",
    today,
    todayCards: 1,
    timeZone: "UTC",
    ...overrides,
  };
}

export function logbookTimeline(
  day: string,
  cards: Partial<LogbookCardPayload>[] = [],
  trackedMs = 0,
): LogbookTimelinePayload {
  return {
    day,
    cards: cards.map((card) => ({
      id: 1,
      day,
      startMs: 1,
      endMs: 2,
      title: "Work",
      summary: "Summary",
      detail: "",
      category: "Coding",
      distractions: [],
      ...card,
    })),
    stats: { trackedMs, distractionMs: 0, categories: [], apps: [] },
  };
}
