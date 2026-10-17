import { vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import * as history from "../config/sessions/session-transcript-worker-runtime.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { createSessionRowProjection } from "./session-row-projection.js";

export async function createTestProjection(
  params: Parameters<typeof createSessionRowProjection>[0],
) {
  const projection = await createSessionRowProjection(params);
  return Object.assign(projection, { [Symbol.dispose]: () => projection.dispose() });
}

export function holdForeground() {
  const release = retainSessionListForegroundWork();
  return Object.assign(release, { [Symbol.dispose]: release });
}

export function seedRow(
  query: string | { agentId: string; key: string; storePath?: string },
  entry: SessionEntry,
) {
  const { key, ...scope } = typeof query === "string" ? { agentId: "main", key: query } : query;
  return replaceSessionEntrySync({ ...scope, sessionKey: key }, entry);
}

export function watchRowFacts(
  wrap: (
    owner: history.SessionHistoryWorkerDatabase,
  ) => history.SessionHistoryWorkerDatabase["readRowFacts"],
  once = false,
) {
  return watchHistoryOwners((owner) => ({ ...owner, readRowFacts: wrap(owner) }), once);
}

function watchHistoryOwners(
  wrap: (owner: history.SessionHistoryWorkerDatabase) => history.SessionHistoryWorkerDatabase,
  once = false,
) {
  const read = history.withSessionHistoryWorkerDatabases;
  const observe: typeof read = (targets, consume, lane) =>
    read(targets, (owners) => consume(owners.map(wrap)), lane);
  const spy = vi.spyOn(history, "withSessionHistoryWorkerDatabases");
  return once ? spy.mockImplementationOnce(observe) : spy.mockImplementation(observe);
}

export function waitForRead(
  gate: Promise<unknown>,
  pending: Promise<unknown>,
  signal: AbortSignal,
  message: string,
) {
  return withinTest(awaitGateBeforeSettlement(gate, pending, message), signal);
}
