import { vi } from "vitest";
import * as sessionReads from "../config/sessions/session-entry-read-runtime.js";
import * as transcript from "../config/sessions/transcript.js";
import type { SessionCatalogProvider } from "../plugins/session-catalog.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import * as sessionRuns from "./session-controller.queries.js";
import "./session-upstream-monitor.js";

type SessionUpstreamMonitorOptions = OpenClawStateDatabaseOptions & {
  providers?: readonly SessionCatalogProvider[];
  now?: () => number;
  signal?: AbortSignal;
};

type SessionUpstreamMissingCounter = {
  count: number;
  linkUpdatedAt: number;
};

type SessionUpstreamMonitorTestApi = {
  runSessionUpstreamMonitorTick(
    options?: SessionUpstreamMonitorOptions,
    missingCounts?: Map<string, SessionUpstreamMissingCounter>,
  ): Promise<void>;
};

export function mockEntry(implementation: typeof sessionReads.readSessionEntryReadOnlyInWorker) {
  return vi
    .spyOn(sessionReads, "readSessionEntryReadOnlyInWorker")
    .mockImplementation(implementation);
}

export function mockRunActive(implementation: typeof sessionRuns.isSessionRunActive) {
  vi.spyOn(sessionRuns, "isSessionRunActive").mockImplementation(implementation);
}

export function mockOwnTexts(texts: string[] = []) {
  vi.spyOn(transcript, "readRecentUserAssistantTextForSession").mockResolvedValue(
    texts.map((text) => ({ role: "user", text })),
  );
}

function getTestApi(): SessionUpstreamMonitorTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.sessionUpstreamMonitorTestApi")
  ] as SessionUpstreamMonitorTestApi;
}

export async function runSessionUpstreamMonitorTick(
  options: SessionUpstreamMonitorOptions = {},
  missingCounts: Map<string, SessionUpstreamMissingCounter> = new Map(),
): Promise<void> {
  await getTestApi().runSessionUpstreamMonitorTick(options, missingCounts);
}
