import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { createControlUiSessionFixtures } from "./control-ui-session-fixtures.ts";

afterEach(() => vi.useRealTimers());

it("samples fresh wire rows without changing stored facts or previous replies", () => {
  vi.useFakeTimers();
  vi.setSystemTime(100);
  const row = {
    key: "agent:main:sampled",
    sessionId: "sampled-session",
    label: "Original session",
    updatedAt: 1,
  };
  const sessions = createControlUiSessionFixtures({ rows: [row], mainKey: row.key }, isRecord);
  const list = (wireRow = row) =>
    sessions.listResponse({ sessions: [wireRow] }, {}, { renames: [], archiveFiltering: false });
  const initialInfo = sessions.sessionInfo(row.key);
  const initialList = list();
  expect(initialInfo).toMatchObject({ label: "Original session", snapshotAt: 100 });
  expect(initialList).toMatchObject({ sessions: [{ label: "Original session", snapshotAt: 100 }] });

  vi.setSystemTime(200);
  const patched = sessions.patch(row.key, { label: "Renamed" });
  expect(patched).toMatchObject({ ok: true, entry: { label: "Renamed" } });
  if (!("entry" in patched)) {
    throw new Error("Expected a successful fixture patch");
  }
  expect(patched.entry).not.toHaveProperty("snapshotAt");
  expect(sessions.read(row.key)).not.toHaveProperty("snapshotAt");
  expect(sessions.sessionInfo(row.key)).toMatchObject({ label: "Renamed", snapshotAt: 200 });
  expect(list()).toMatchObject({ sessions: [{ label: "Renamed", snapshotAt: 200 }] });
  expect(initialInfo).toMatchObject({ label: "Original session", snapshotAt: 100 });
  expect(initialList).toMatchObject({ sessions: [{ label: "Original session", snapshotAt: 100 }] });
  expect(
    sessions.listResponse(
      { sessions: [{ ...row, snapshotAt: 50 }] },
      {},
      { renames: [], archiveFiltering: false },
    ),
  ).toMatchObject({ sessions: [{ label: "Renamed", snapshotAt: 50 }] });
});
