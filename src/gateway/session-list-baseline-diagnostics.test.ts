import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  prepareSessionRowPublication,
  shareSidebarSessionRows,
} from "./session-row-presentation.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

beforeEach(() => resetDiagnosticEventsForTest());
afterEach(() => {
  vi.restoreAllMocks();
  resetDiagnosticEventsForTest();
});

it("counts each retirement event once across invalidations and bounded evictions", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const causes: string[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (event.type === "sessions.list.baseline.retired") {
        causes.push(event.cause);
      }
    });
    const projection = await createSessionRowProjection({ cfg: {}, modelCatalog: [] });
    let state = projection.state;
    // Control upstream revisions; exercise the real publication owner and its bounded caches.
    vi.spyOn(projection, "state", "get").mockImplementation(() => state);
    const present = () => prepareSessionRowPublication(projection, 1)();
    const row: GatewaySessionRow = {
      key: "agent:main:one",
      kind: "direct",
      updatedAt: 1,
      rowMode: "sidebar",
    };
    const opts = { rowMode: "sidebar" } as const;
    const expectCauses = async (expected: string[]) => {
      await waitForDiagnosticEventsDrained();
      expect(causes.splice(0)).toEqual(expected);
    };
    try {
      state = { ...state, revision: {} };
      present();
      await expectCauses([]);
      present().list([], opts);
      state = { ...state, revision: {} };
      present();
      await expectCauses([]);
      for (const cause of ["config", "identity"] as const) {
        present().list([row], opts);
        present().list([row], { ...opts, limit: 2 });
        if (cause === "identity") {
          state.rowContext.identityProjection?.invalidate();
        } else {
          state = Object.assign(
            {},
            state,
            { revision: {} },
            cause === "config" ? { cfg: { ...state.cfg } } : {},
          );
        }
        present();
        present();
        await expectCauses([cause]);
      }

      const historyView = present();
      let initialRevision: string | undefined;
      for (let generation = 0; generation <= 33; generation++) {
        const { sessions, rowHistory } = historyView.list(
          [{ ...row, updatedAt: generation }],
          opts,
        );
        const result = shareSidebarSessionRows(sessions, undefined, rowHistory);
        initialRevision ??= result.rowsRevision;
        if (generation === 32) {
          expect(rowHistory).toHaveLength(32);
          await expectCauses([]);
        } else if (generation === 33) {
          expect(
            shareSidebarSessionRows(sessions, `delta:${initialRevision}`, rowHistory).rowsDelta,
          ).toBeUndefined();
          await expectCauses(["history-evicted"]);
        }
      }
      for (let limit = 1; limit <= 512; limit++) {
        present().list([row], { ...opts, limit });
      }
      await expectCauses(["view-evicted"]);
      projection.dispose();
      await expectCauses(["selection-reset"]);
      projection.dispose();
      await expectCauses([]);
    } finally {
      unsubscribe();
      projection.dispose();
    }
  });
});

it("does not count selection-only or non-sidebar views as retired baselines", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const causes: string[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (event.type === "sessions.list.baseline.retired") {
        causes.push(event.cause);
      }
    });
    const projection = await createSessionRowProjection({ cfg: {}, modelCatalog: [] });
    let state = projection.state;
    vi.spyOn(projection, "state", "get").mockImplementation(() => state);
    const present = () => prepareSessionRowPublication(projection, 1)();
    const populate = () => {
      present().select({ rowMode: "sidebar" }, () => ({
        entries: [],
        totalCount: 0,
        ownerFacet: [],
        ownerCount: 0,
        offset: 0,
        nextOffset: null,
        hasMore: false,
      }));
      for (const rowMode of [undefined, "compact", "dashboard"] as const) {
        present().list([{ key: "agent:main:one", kind: "direct", updatedAt: 1, rowMode }], {
          rowMode,
        });
      }
    };
    try {
      for (const cause of ["projection-revision", "config", "identity"] as const) {
        populate();
        if (cause === "identity") {
          state.rowContext.identityProjection?.invalidate();
        } else {
          state = Object.assign(
            {},
            state,
            { revision: {} },
            cause === "config" ? { cfg: { ...state.cfg } } : {},
          );
        }
        present();
      }
      populate();
      for (let limit = 1; limit <= 513; limit++) {
        present().list([], { rowMode: "compact", limit });
      }
      projection.dispose();
      await waitForDiagnosticEventsDrained();
      expect(causes).toEqual([]);
    } finally {
      unsubscribe();
      projection.dispose();
    }
  });
});
