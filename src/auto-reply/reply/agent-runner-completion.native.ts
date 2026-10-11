import { loadSessionEntry, patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import type { SessionActorReducer } from "../../config/sessions/session-actor-contract.js";
import { reduceSessionActorEntry } from "../../config/sessions/session-actor-reducers.js";
import { captureIncognitoSessionSource } from "../../config/sessions/session-incognito-binding.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import { logVerbose } from "../../globals.js";
import {
  borrowOpenClawAgentDatabase,
  getOpenClawAgentDatabaseIfOpen,
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import type { AgentTurnCompletion } from "./agent-runner-completion.types.js";

/** Native incognito keeps its existing in-process entry owner until its worker cutover. */
export async function withNativeIncognitoTurnCompletion<T>(
  params: {
    agentId?: string;
    storePath: string;
    sessionKey: string;
    writer: Pick<SessionEntry, "sessionId" | "lifecycleRevision" | "activeWriterRunId">;
    assertCurrent(): void;
    publish(entry: SessionEntry): void;
  },
  consume: (completion: AgentTurnCompletion) => Promise<T>,
): Promise<{ value: T } | undefined> {
  const scope = resolveSqliteScope(params);
  const options = toDatabaseOptions(scope);
  const pathname = resolveOpenClawAgentSqlitePath(options);
  if (
    !isIncognitoOpenClawAgentSqlitePath(pathname, options) ||
    captureIncognitoSessionSource(params)
  ) {
    return undefined;
  }
  const owner = getOpenClawAgentDatabaseIfOpen(options);
  if (!owner) {
    throw new Error("Terminal accounting session is unavailable");
  }
  const retained = borrowOpenClawAgentDatabase(options);
  const assertCurrent = () => {
    params.assertCurrent();
    if (getOpenClawAgentDatabaseIfOpen(options) !== owner) {
      throw new Error("Terminal accounting lost its native incognito owner");
    }
  };
  const assertEntry = (entry: SessionEntry | undefined): SessionEntry => {
    if (
      !entry ||
      entry.sessionId !== params.writer.sessionId ||
      entry.lifecycleRevision !== params.writer.lifecycleRevision ||
      entry.activeWriterRunId !== params.writer.activeWriterRunId
    ) {
      throw new Error("Terminal accounting session changed");
    }
    return entry;
  };
  try {
    assertCurrent();
    let snapshot = assertEntry(loadSessionEntry(params));
    const prepared: Parameters<AgentTurnCompletion["patch"]>[0][] = [];
    let finished = false;
    const project = (entry: SessionEntry) => {
      let next = structuredClone(entry);
      const reducers: SessionActorReducer[] = [];
      for (const preparation of prepared) {
        const reducer = typeof preparation === "function" ? preparation(next) : preparation;
        if (reducer) {
          reducers.push(reducer);
          next = reduceSessionActorEntry(next, [reducer]);
        }
      }
      return { entry: next, reducers };
    };
    const refresh = async () => {
      assertCurrent();
      snapshot = assertEntry(loadSessionEntry(params));
      return project(snapshot).entry;
    };
    const completion: AgentTurnCompletion = {
      current: () => project(snapshot).entry,
      refresh,
      patch(reducer) {
        if (finished) {
          throw new Error("Terminal accounting is already settled");
        }
        prepared.push(reducer);
      },
      async complete(pendingFinalDelivery) {
        if (finished) {
          if (pendingFinalDelivery) {
            throw new Error("Final delivery custody is already settled");
          }
          return snapshot;
        }
        finished = true;
        await refresh();
        const { reducers } = project(snapshot);
        if (reducers.length === 0 && !pendingFinalDelivery) {
          return snapshot;
        }
        let committed = false;
        try {
          const result = await patchSessionEntryCore(
            params,
            (entry) => ({
              ...project(assertEntry(entry)).entry,
              ...(pendingFinalDelivery ? { pendingFinalDelivery, updatedAt: Date.now() } : {}),
            }),
            {
              skipMaintenance: true,
              assertCommitAllowed: assertCurrent,
              onCommitted(entry) {
                committed = true;
                snapshot = entry;
                params.publish(entry);
              },
            },
          );
          if (!result) {
            throw new Error("Terminal accounting session is unavailable");
          }
          return snapshot;
        } catch (error) {
          await refresh();
          if (
            committed ||
            pendingFinalDelivery ||
            !reducers.every((reducer) => reducer.kind === "usage")
          ) {
            throw error;
          }
          logVerbose(`failed to persist usage update: ${String(error)}`);
          return snapshot;
        }
      },
    };
    let value: T;
    try {
      value = await consume(completion);
    } catch (error) {
      try {
        await completion.complete();
      } catch (settlementError) {
        throw new AggregateError([error, settlementError], "Terminal accounting failed to settle", {
          cause: settlementError,
        });
      }
      throw error;
    }
    await completion.complete();
    return { value };
  } finally {
    retained.release();
  }
}
