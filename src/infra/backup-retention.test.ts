import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import {
  normalizeBackupRetention,
  resolveBackupNamespace,
  selectBackupRetention,
  type BackupRetention,
  type BackupRetentionOptions,
} from "./backup-retention.js";

const key = (timestamp: string) => `${timestamp}-0123abcd.tar.gz`;
const timestamps = [
  "20270104T000100Z",
  "20270104T000000Z",
  "20270103T235900Z",
  "20270101T230000Z",
  "20261231T235900Z",
  "20261228T010000Z",
  "20261227T235900Z",
  "20261201T120000Z",
  "20261130T120000Z",
  "20261101T120000Z",
];
const backups = timestamps.map(key);
const foreign = [
  `other-host/${backups[0]}`,
  `backups/other-host/${backups[0]}`,
  "notes.txt",
  "archive.tar.gz",
  "20270101T000000Z-deadbeef.tar.gz.extra",
  "20270101T000000Z-deadbee.tar.gz",
  "20260230T000000Z-0123abcd.tar.gz",
  "20270101T250000Z-0123abcd.tar.gz",
];

afterEach(() => vi.restoreAllMocks());

it.each<[string, BackupRetention, number[]]>([
  ["all without flags", {}, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]],
  ["newest with zero counts", { keepDaily: 0, keepWeekly: 0, keepMonthly: 0 }, [0]],
  ["nonempty UTC days", { keepDaily: 3 }, [0, 2, 3]],
  ["Monday weeks across a year boundary", { keepWeekly: 2 }, [0, 2]],
  ["UTC months across a year boundary", { keepMonthly: 2 }, [0, 4]],
  ["daily/weekly/monthly union", { keepDaily: 2, keepWeekly: 3, keepMonthly: 3 }, [0, 2, 4, 6, 8]],
])("keeps %s and excludes foreign keys", (_label, policy, indexes) => {
  const kept = indexes.map((index) => backups[index]);
  const selected = selectBackupRetention([...foreign, ...backups.toReversed()], policy);
  expect(selected).toEqual({
    kept,
    deleted: backups.filter((backup) => !kept.includes(backup)),
  });
});

it.each<{ options: BackupRetentionOptions; expected?: BackupRetention }>([
  {
    options: { keepDaily: "7", keepWeekly: 0, keepMonthly: "12" },
    expected: { keepDaily: 7, keepWeekly: 0, keepMonthly: 12 },
  },
  { options: { keepDaily: "" } },
  { options: { keepDaily: "-1" } },
  { options: { keepDaily: -1 } },
  { options: { keepWeekly: "1.5" } },
  { options: { keepMonthly: Infinity } },
  { options: { keepMonthly: Number.NaN } },
  { options: { keepDaily: Number.MAX_SAFE_INTEGER + 1 } },
])("validates retention counts $options", ({ options, expected }) => {
  if (expected) {
    expect(normalizeBackupRetention(options)).toEqual(expected);
  } else {
    expect(() => normalizeBackupRetention(options)).toThrow("must be a nonnegative integer");
  }
});
it.each<[string | undefined, string | undefined]>([
  [undefined, "Peter-s-Mac.local"],
  ["Host_A-2.local", "Host_A-2.local"],
  ...["", ".", "..", "../other-host", "host/child", "host name", "a".repeat(129)].map(
    (namespace): [string, undefined] => [namespace, undefined],
  ),
])("validates the namespace %j", (namespace, expected) => {
  vi.spyOn(os, "hostname").mockReturnValue("Peter's Mac.local");
  if (expected) {
    expect(resolveBackupNamespace(namespace)).toBe(expected);
  } else {
    expect(() => resolveBackupNamespace(namespace)).toThrow("Backup namespace");
  }
});
