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

const baseRow: GatewaySessionRow = { key: "agent:main:one", kind: "direct", updatedAt: 1 };

async function publicationFixture() {
  const projection = await createSessionRowProjection({ cfg: {}, modelCatalog: [] });
  let state = projection.state;
  vi.spyOn(projection, "state", "get").mockImplementation(() => state);
  const causes: string[] = [];
  const unsubscribe = onInternalDiagnosticEvent((event) => {
    if (event.type === "sessions.list.baseline.retired") {
      causes.push(event.cause);
    }
  });
  return {
    projection,
    present: () => prepareSessionRowPublication(projection, 1)().getPresentation(),
    invalidate: (cause: "projection-revision" | "config" | "identity") => {
      if (cause === "identity") {
        state.rowContext.identityProjection?.invalidate();
      } else {
        state = { ...state, revision: {}, cfg: cause === "config" ? { ...state.cfg } : state.cfg };
      }
    },
    expectCauses: async (expected: string[]) => {
      await waitForDiagnosticEventsDrained();
      expect(causes.splice(0)).toEqual(expected);
    },
    [Symbol.dispose]() {
      unsubscribe();
      projection.dispose();
    },
  };
}

it.each([true, false])(
  "reports baseline retirement only for sidebar rows (sidebar=%s)",
  (sidebar) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      using fixture = await publicationFixture();
      const { projection, present, invalidate, expectCauses } = fixture;
      const opts = { rowMode: sidebar ? "sidebar" : "compact" } as const;
      const row: GatewaySessionRow = { ...baseRow, ...opts };
      const populate = () => {
        if (sidebar) {
          present().list([row], opts);
          present().list([row], { ...opts, limit: 2 });
          return;
        }
        present().select({ rowMode: "sidebar" }, () => ({
          entries: [],
          totalCount: 0,
          ownerFacet: [],
          ownerCount: 0,
          offset: 0,
          nextOffset: null,
          hasMore: false,
        }));
        present().list([{ ...baseRow, rowMode: "compact" }], { rowMode: "compact" });
      };
      invalidate("projection-revision");
      present();
      await expectCauses([]);
      present().list([], opts);
      invalidate("projection-revision");
      present();
      await expectCauses([]);
      for (const cause of ["projection-revision", "config", "identity"] as const) {
        populate();
        invalidate(cause);
        present();
        present();
        await expectCauses(sidebar && cause !== "projection-revision" ? [cause] : []);
      }
      if (sidebar) {
        const historyView = present();
        let initialRevision: string | undefined;
        for (let generation = 0; generation <= 33; generation++) {
          const { sessions, rowHistory } = historyView.list(
            [{ ...row, updatedAt: generation }],
            opts,
          );
          initialRevision ??= shareSidebarSessionRows(sessions, undefined, rowHistory).rowsRevision;
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
      } else {
        populate();
      }
      for (let limit = 1; limit <= (sidebar ? 512 : 513); limit++) {
        present().list(sidebar ? [row] : [], { ...opts, limit });
      }
      await expectCauses(sidebar ? ["view-evicted"] : []);
      projection.dispose();
      await expectCauses(sidebar ? ["selection-reset"] : []);
      projection.dispose();
      await expectCauses([]);
    }),
);
