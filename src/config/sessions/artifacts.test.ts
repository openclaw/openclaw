import { expect, it } from "vitest";
import {
  formatSessionArchiveTimestamp,
  isMigrationArchiveArtifactName as migrationName,
  isSessionArchiveArtifactName as archiveName,
  isSessionStoreTempArtifactName,
  isTrajectorySessionArtifactName as trajectoryName,
  parseUsageCountedSessionIdFromFileName,
  parseSessionArchiveTimestamp,
} from "./artifacts.js";

const stamp = "2026-01-01T00-00-00.000Z";
const deleted = `abc.jsonl.deleted.${stamp}`;
const reset = `abc.jsonl.reset.${stamp}`;
const backup = `abc.jsonl.bak.${stamp}`;
const checkpoint = "abc.checkpoint.11111111-1111-4111-8111-111111111111.jsonl";
const invalidCheckpoint = "abc.checkpoint.not-a-uuid.jsonl";
const uuid = "0f9c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const generation = "a".repeat(32);
const store = "sessions.json";
const storeBackup = "sessions.json.bak.1737420882";
const trajectory = "abc.trajectory.jsonl";
const storeTemp = (name: string) => isSessionStoreTempArtifactName(name, store);

it.each([
  [
    archiveName,
    [deleted, `${deleted}.${generation}`, reset, backup, storeBackup],
    ["keep.deleted.keep.jsonl", "abc.jsonl"],
  ],
  [
    migrationName,
    ["abc.jsonl.migrated", "sessions.json.migrated.2"],
    ["abc.jsonl.migrated.tmp", "abc.jsonl.MIGRATED"],
  ],
  [
    storeTemp,
    [`sessions.json.12345.${uuid}.tmp`, `sessions.json.${uuid}.tmp`],
    [store, "sessions.json.tmp", `my-store.json.99.${uuid}.tmp`, `sessionsXjson.99.${uuid}.tmp`],
  ],
  [trajectoryName, [trajectory, "abc.trajectory-path.json"], ["abc.jsonl"]],
] satisfies [(name: string) => boolean, string[], string[]][])(
  "classifies $0.name",
  (classify, accepted, rejected) => {
    expect(accepted.map(classify)).toEqual(accepted.map(() => true));
    expect(rejected.map(classify)).toEqual(rejected.map(() => false));
  },
);

it("matches only the custom store's temp files", () => {
  expect(isSessionStoreTempArtifactName(`my-store.json.99.${uuid}.tmp`, "my-store.json")).toBe(
    true,
  );
  expect(isSessionStoreTempArtifactName(`sessions.json.99.${uuid}.tmp`, "my-store.json")).toBe(
    false,
  );
});

it("parses usage-counted session ids from file names", () => {
  const cases = [
    ["abc", ["abc.jsonl", reset, deleted, `${deleted}.${generation}`, `${reset}.zst`]],
    ["", [".jsonl"]],
    ["keep.deleted.keep", ["keep.deleted.keep.jsonl"]],
    ["abc.checkpoint.not-a-uuid", [`${invalidCheckpoint}.deleted.${stamp}`]],
    [
      null,
      [
        store,
        backup,
        checkpoint,
        trajectory,
        `${trajectory}.reset.${stamp}.zst`,
        `${checkpoint}.reset.${stamp}.zst`,
        `.jsonl.reset.${stamp}`,
        `${deleted}.${"A".repeat(32)}`,
      ],
    ],
  ] as const;
  for (const [id, names] of cases) {
    expect(names.map(parseUsageCountedSessionIdFromFileName)).toEqual(names.map(() => id));
  }
});

it("formats and parses archive timestamps", () => {
  const now = Date.parse("2026-02-23T12:34:56.000Z");
  const formatted = formatSessionArchiveTimestamp(now);
  expect(formatted).toBe("2026-02-23T12-34-56.000Z");
  const file = `abc.jsonl.deleted.${formatted}`;
  expect(parseSessionArchiveTimestamp(file, "deleted")).toBe(now);
  expect(parseSessionArchiveTimestamp(`${file}.${generation}`, "deleted")).toBe(now);
  expect(parseSessionArchiveTimestamp(file, "reset")).toBeNull();
  expect(parseSessionArchiveTimestamp("keep.deleted.keep.jsonl", "deleted")).toBeNull();
});
