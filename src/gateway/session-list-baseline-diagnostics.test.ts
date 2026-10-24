import { setImmediate } from "node:timers/promises";
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
import { prepareSessionRowPublicationView } from "./session-row-publication.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

beforeEach(() => resetDiagnosticEventsForTest());
afterEach(() => {
  vi.restoreAllMocks();
  resetDiagnosticEventsForTest();
});

const baseRow: GatewaySessionRow = { key: "agent:main:one", kind: "direct", updatedAt: 1 };

async function publicationFixture(controlState = false) {
  const projection = await createSessionRowProjection({ cfg: {}, modelCatalog: [] });
  let state = projection.state;
  if (controlState) {
    vi.spyOn(projection, "state", "get").mockImplementation(() => state);
  }
  const causes: string[] = [];
  let retainedBytes = 0;
  const unsubscribe = onInternalDiagnosticEvent((event) => {
    if (event.type === "sessions.list.baseline.retired") {
      causes.push(event.cause);
    }
    if (event.type === "sessions.list.retention") {
      retainedBytes = event.estimatedBytes;
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
    flush: async () => {
      await setImmediate();
      await waitForDiagnosticEventsDrained();
      return retainedBytes;
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

it.each([1, 2])("accounts for %s promoted rows and releases all encodings", async (count) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    using fixture = await publicationFixture();
    const { projection, present, flush } = fixture;
    const publication = prepareSessionRowPublicationView(projection)();
    const opts = { rowMode: "compact" } as const;
    const rows: GatewaySessionRow[] = Array.from({ length: count }, (_, index) => ({
      ...baseRow,
      key: `agent:main:${index}`,
      rowMode: "compact",
      label: `${index} ${"synthetic ".repeat(256)}`,
    }));
    present().list(rows, opts);
    present().list(rows, { ...opts, limit: 2 });
    const legacyBytes = await flush();
    present().list(rows, { ...opts, ifRowsRevision: "" });
    const encoded = rows.map((row) => JSON.stringify(row));
    const packedBytes =
      encoded.reduce((bytes, row) => bytes + row.length * 2, 0) +
      Buffer.byteLength(`[${encoded.join(",")}]`);
    const factBytes =
      count === 1
        ? 0
        : rows.reduce((bytes, row) => bytes + JSON.stringify({ label: row.label }).length * 2, 0);
    expect(await flush()).toBe(legacyBytes + packedBytes + factBytes);
    const promoted = [...publication.lists.values()].find((view) => view.conditional)!;
    expect(promoted.rowHistory).toBeUndefined();
    present().list(
      rows.map((row) => ({ ...row, updatedAt: 2 })),
      opts,
    );
    expect(promoted.rowHistory).toHaveLength(1);
    expect(promoted.encodedBytes).toBeGreaterThan(
      rows.reduce((bytes, row) => bytes + row.label!.length * 3, 0),
    );
    publication.lists.retireRows(promoted);
    for (const view of publication.lists.values()) {
      publication.lists.retireRows(view);
    }
    expect(await flush()).toBe(
      [...publication.lists.values()].reduce((bytes, view) => bytes + view.bytes, 0),
    );
    projection.dispose();
    expect(await flush()).toBe(0);
  });
});

it.each([true, false])(
  "reports baseline retirement only for sidebar rows (sidebar=%s)",
  (sidebar) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      using fixture = await publicationFixture(true);
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
        for (const rowMode of [undefined, "compact", "dashboard"] as const) {
          present().list([{ ...baseRow, rowMode }], { rowMode });
        }
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
