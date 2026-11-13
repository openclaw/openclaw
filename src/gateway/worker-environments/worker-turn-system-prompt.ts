import {
  beginSessionSystemPrompt,
  buildSystemPromptRouteKey,
  persistSessionSystemPrompt,
  prepareSessionSystemPrompt,
  retainEmbeddedSessionPromptState,
  retireSessionSystemPrompt,
} from "../../agents/embedded-agent-runner/session-prompt-state.js";
import { getOpenClawSystemUpdateKind } from "../../agents/internal-runtime-context.js";
import type { AgentMessage } from "../../agents/runtime/index.js";
import { sessionManagerReadTranscriptBranch } from "../../agents/sessions/session-manager-view-types.js";
import { withSessionManagerWrite } from "../../agents/sessions/session-manager-write-admission.js";
import type { SessionManager } from "../../agents/sessions/session-manager.js";
import type { Model } from "../../llm/types.js";

/** Worker turns run the same harness prompt; only the execution host differs. */
export const WORKER_SYSTEM_PROMPT_HARNESS = "openclaw";

export function buildWorkerSystemPromptRouteKey(params: {
  model: Pick<Model, "provider" | "id" | "api" | "baseUrl">;
  inHistorySystemUpdates?: boolean;
  personalProfile?: string;
}): string {
  return buildSystemPromptRouteKey({
    provider: params.model.provider,
    model: params.model.id,
    api: params.model.api,
    baseUrl: params.model.baseUrl,
    inHistorySystemUpdates: params.inHistorySystemUpdates === true,
    personalProfile: params.personalProfile,
    harness: WORKER_SYSTEM_PROMPT_HARNESS,
    surface: "worker",
  });
}

/**
 * Pin a worker turn to the session's system prompt series, as embedded turns do.
 *
 * The Gateway owns the transcript, so it reads the checkpoint before launch, sends the
 * pinned prefix, carries any change as an appended `prompt-update` message, and writes
 * the checkpoint only after the worker has committed its turn.
 */
export async function prepareWorkerSessionSystemPrompt(params: {
  sessionId: string;
  manager: SessionManager;
  routeKey: string;
  systemPrompt: string;
  history: AgentMessage[];
  /** Admits a pre-launch transcript write for this turn's writer. */
  write: <T>(operation: () => Promise<T>) => Promise<T>;
}) {
  // The Gateway restores the series from the checkpoint each turn; the state object
  // stays valid for this turn's commit after the lease ends.
  using lease = retainEmbeddedSessionPromptState(params.sessionId);
  const state = lease.state;
  const appendEntry = (customType: string, data: unknown) =>
    params.write(() =>
      withSessionManagerWrite(params.manager, () =>
        params.manager.appendCustomEntryAsync(customType, data),
      ),
    );
  {
    beginSessionSystemPrompt(state);
    const prepared = prepareSessionSystemPrompt({
      state,
      routeKey: params.routeKey,
      systemPrompt: params.systemPrompt,
      entries: params.manager[sessionManagerReadTranscriptBranch](),
      historyBoundaryCount: params.manager.getBoundaryCount(),
    });
    let history = params.history;
    let restartRecorded = false;
    if (prepared.restart && prepared.seriesStatus !== "restarted:new") {
      // A rebuild point retires earlier deltas; the new prefix already contains them.
      await retireSessionSystemPrompt(state, params.routeKey, appendEntry);
      restartRecorded = true;
      history = history.filter(
        (message) => getOpenClawSystemUpdateKind(message) !== "prompt-update",
      );
    }
    return {
      systemPrompt: prepared.systemPrompt,
      seriesStatus: prepared.seriesStatus,
      history,
      update: prepared.update,
      /** Persist the delta before the user message, so stored order matches sent order. */
      persistUpdate: async () => {
        const update = prepared.update;
        if (!update) {
          return;
        }
        await params.write(() =>
          withSessionManagerWrite(params.manager, () =>
            params.manager.appendCustomMessageEntryAsync(
              update.customType,
              update.content,
              update.display,
              update.details,
            ),
          ),
        );
      },
      /**
       * Record the series after the worker commits; a failed turn leaves no checkpoint. The
       * checkpoint must follow the worker's rows, so it is written through the result manager.
       */
      commit: async (
        manager: SessionManager,
        write: <T>(operation: () => Promise<T>) => Promise<T>,
      ) => {
        prepared.commit(restartRecorded);
        await persistSessionSystemPrompt(state, (customType, data) =>
          write(() =>
            withSessionManagerWrite(manager, () =>
              manager.appendCustomEntryAsync(customType, data),
            ),
          ),
        );
      },
    };
  }
}

/**
 * Apply the session pin to a rendered worker prompt. The delta is stored before the
 * user message, so stored order matches sent order; raw model runs carry no series.
 */
export async function pinWorkerTurnPrompt(params: {
  turn: { modelRun?: boolean; promptMode?: string; bootstrapUserProfileId?: string };
  sessionId: string;
  manager: SessionManager;
  model: Pick<Model, "provider" | "id" | "api" | "baseUrl">;
  inHistorySystemUpdates?: boolean;
  systemPrompt: string;
  history: AgentMessage[];
  write: <T>(operation: () => Promise<T>) => Promise<T>;
}) {
  const { turn } = params;
  if (turn.modelRun === true || turn.promptMode === "none") {
    return undefined;
  }
  const pin = await prepareWorkerSessionSystemPrompt({
    ...params,
    routeKey: buildWorkerSystemPromptRouteKey({
      model: params.model,
      inHistorySystemUpdates: params.inHistorySystemUpdates,
      personalProfile: turn.bootstrapUserProfileId,
    }),
  });
  await pin.persistUpdate();
  return {
    systemPrompt: pin.systemPrompt,
    history: pin.update ? [...pin.history, pin.update] : pin.history,
    commit: pin.commit,
  };
}
