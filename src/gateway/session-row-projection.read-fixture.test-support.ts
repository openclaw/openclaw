import { vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import * as history from "../config/sessions/session-transcript-worker-runtime.js";
import type { SessionEntry } from "../config/sessions/types.js";

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
  const read = history.withSessionHistoryWorkerDatabases;
  const observe: typeof read = (targets, consume, lane) =>
    read(
      targets,
      (owners) =>
        consume(
          owners.map((owner) => ({
            ...owner,
            readRowFacts: wrap(owner),
          })),
        ),
      lane,
    );
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
