import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { resolveSessionRowProjection } from "../../../packages/gateway-protocol/src/session-row-fields.js";
import { createControlUiSessionFixtures } from "./control-ui-session-fixtures.ts";

afterEach(() => vi.useRealTimers());

it("projects list and describe replies without narrowing the fixture's canonical rows", () => {
  const row = {
    key: "agent:main:projected",
    sessionId: "projected-session",
    kind: "direct",
    updatedAt: 1,
    label: "Visible title",
    model: "fixture-model",
  };
  const sessions = createControlUiSessionFixtures(
    { rows: [row], mainKey: row.key },
    isRecord,
    resolveSessionRowProjection,
  );
  const params = { fields: ["label"] };
  const responses = [
    sessions.listResponse({ sessions: [row] }, params, { renames: [], archiveFiltering: false }),
    sessions.readResponse(
      "sessions.describe",
      { key: row.key, ...params },
      {
        sessionKey: row.key,
        allowedSessionVisibilities: [],
      },
    ),
    sessions.describeResponse({ session: row }, params),
  ];
  for (const response of responses) {
    if (!isRecord(response) || !isRecord(response.rowProjection)) {
      throw new Error("Expected a session row projection descriptor");
    }
    const projected = Array.isArray(response.sessions) ? response.sessions[0] : response.session;
    expect(projected).toMatchObject({
      key: row.key,
      sessionId: row.sessionId,
      kind: row.kind,
      updatedAt: row.updatedAt,
      label: row.label,
      rowMode: "fields",
      rowProjectionId: response.rowProjection.id,
    });
    expect(projected).not.toHaveProperty("model");
    expect(projected).not.toHaveProperty("snapshotAt");
    expect(response.rowProjection.fields).toEqual(
      expect.arrayContaining([
        "key",
        "kind",
        "updatedAt",
        "sessionId",
        "lifecycleRevision",
        "label",
      ]),
    );
    expect(response.rowProjection.fields).not.toContain("model");
  }
  expect(sessions.read(row.key)).toMatchObject({ label: row.label, model: row.model });
  expect(sessions.describeResponse({ session: row }, {})).toEqual({ session: row });
});

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
