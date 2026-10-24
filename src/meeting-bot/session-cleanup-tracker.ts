import { throwIfSettledRejected } from "../infra/error-graph-internal.js";

type MeetingSessionCleanupProgress = {
  browserLeft?: boolean;
  browserSettled: boolean;
  stopSettled: boolean;
};

type MeetingSessionCleanupState = {
  stops: Set<() => Promise<void>>;
  setup?: Promise<void>;
  stopping?: Promise<void>;
  cleanup?: MeetingSessionCleanupProgress;
  unpublished?: boolean;
};

export class MeetingSessionCleanupTracker {
  readonly #states = new Map<string, MeetingSessionCleanupState>();

  #state(sessionId: string): MeetingSessionCleanupState {
    let state = this.#states.get(sessionId);
    if (!state) {
      state = { stops: new Set() };
      this.#states.set(sessionId, state);
    }
    return state;
  }

  prepareRuntime(sessionId: string, prepare: () => Promise<void>): Promise<void> {
    const state = this.#state(sessionId);
    if (state.setup) {
      return state.setup;
    }
    // Install custody before invoking callbacks, including synchronous reentry.
    const setup = Promise.resolve()
      .then(prepare)
      .finally(() => {
        state.setup = undefined;
      });
    state.setup = setup;
    return setup;
  }

  addStop(sessionId: string, stop: () => Promise<void>): void {
    this.#state(sessionId).stops.add(stop);
  }

  hasRuntime(sessionId: string): boolean {
    const state = this.#states.get(sessionId);
    return Boolean(state?.setup || state?.stops.size);
  }

  retainFailedJoin(sessionId: string): void {
    this.#state(sessionId).unpublished = true;
  }

  stopRuntime(sessionId: string): Promise<void> {
    const state = this.#states.get(sessionId);
    if (!state) {
      return Promise.resolve();
    }
    if (state.stopping) {
      return state.stopping;
    }
    const stopping = Promise.resolve()
      .then(async () => {
        // Startup reports its own failure; cleanup still drains every adopted handle.
        await state.setup?.catch(() => undefined);
        const results = await Promise.allSettled(
          [...state.stops].map(async (stop) => {
            await stop();
            state.stops.delete(stop);
          }),
        );
        throwIfSettledRejected(results, "Meeting runtime cleanup failed");
      })
      .finally(() => {
        state.stopping = undefined;
      });
    state.stopping = stopping;
    return stopping;
  }

  begin(sessionId: string, browserLeft?: boolean): boolean {
    const state = this.#state(sessionId);
    if (state.cleanup) {
      return false;
    }
    state.cleanup = { browserLeft, browserSettled: false, stopSettled: false };
    return true;
  }

  isPending(sessionId: string): boolean {
    return this.#states.get(sessionId)?.cleanup !== undefined;
  }

  async cleanup(params: {
    sessionId: string;
    keepBrowserTab: boolean;
    hasBrowserTab: () => boolean;
    releaseBrowser: () => Promise<boolean | undefined>;
  }): Promise<{ browserLeft?: boolean; complete: boolean; unpublished: boolean }> {
    const state = this.#states.get(params.sessionId)?.cleanup;
    if (!state) {
      throw new Error("Missing cleanup state for meeting session " + params.sessionId);
    }
    let cleanupError: unknown;
    if (!state.stopSettled) {
      try {
        await this.stopRuntime(params.sessionId);
        state.stopSettled = true;
      } catch (error) {
        cleanupError = error;
      }
    }
    if (!state.browserSettled) {
      try {
        if (params.keepBrowserTab) {
          state.browserSettled = true;
        } else {
          state.browserLeft = await params.releaseBrowser();
          // No owned tab means no browser cleanup to retry; preserve the leave diagnostic.
          state.browserSettled = state.browserLeft !== false || !params.hasBrowserTab();
        }
      } catch (error) {
        cleanupError ??= error;
      }
    }
    const unpublished = this.#states.get(params.sessionId)?.unpublished === true;
    const complete = this.#completeIfSettled(params.sessionId, state);
    if (cleanupError) {
      throw cleanupError instanceof Error
        ? cleanupError
        : new Error("Meeting session cleanup failed", { cause: cleanupError });
    }
    return { browserLeft: state.browserLeft, complete, unpublished };
  }

  #completeIfSettled(sessionId: string, state: MeetingSessionCleanupProgress): boolean {
    if (!state.stopSettled || !state.browserSettled || this.hasRuntime(sessionId)) {
      return false;
    }
    this.#states.delete(sessionId);
    return true;
  }
}
