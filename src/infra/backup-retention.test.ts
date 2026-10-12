import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("backup retention", () => {
  it.each<{ label: string; policy: BackupRetention; kept: string[] }>([
    { label: "no deletion without flags", policy: {}, kept: timestamps },
    {
      label: "newest even when every count is zero",
      policy: { keepDaily: 0, keepWeekly: 0, keepMonthly: 0 },
      kept: ["20270104T000100Z"],
    },
    {
      label: "newest in each nonempty UTC day with other periods unspecified",
      policy: { keepDaily: 3 },
      kept: ["20270104T000100Z", "20270103T235900Z", "20270101T230000Z"],
    },
    {
      label: "Monday weeks across a year boundary",
      policy: { keepWeekly: 2 },
      kept: ["20270104T000100Z", "20270103T235900Z"],
    },
    {
      label: "UTC calendar months across a year boundary",
      policy: { keepMonthly: 2 },
      kept: ["20270104T000100Z", "20261231T235900Z"],
    },
    {
      label: "union of daily, weekly, and monthly buckets across a year boundary",
      policy: { keepDaily: 2, keepWeekly: 3, keepMonthly: 3 },
      kept: [
        "20270104T000100Z",
        "20270103T235900Z",
        "20261231T235900Z",
        "20261227T235900Z",
        "20261130T120000Z",
      ],
    },
  ])("keeps $label and excludes foreign keys", ({ policy, kept }) => {
    const selected = selectBackupRetention([...foreign, ...backups.toReversed()], policy);
    expect(selected.kept).toEqual(kept.map(key));
    expect(selected.deleted).toEqual(
      timestamps.filter((timestamp) => !kept.includes(timestamp)).map(key),
    );
    expect([...selected.kept, ...selected.deleted].toSorted()).toEqual(backups.toSorted());
    expect(selected.kept[0]).toBe(backups[0]);
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
});

describe("backup namespaces", () => {
  it.each([
    { namespace: undefined, expected: "Peter-s-Mac.local" },
    { namespace: "Host_A-2.local", expected: "Host_A-2.local" },
    ...["", ".", "..", "../other-host", "host/child", "host name", "a".repeat(129)].map(
      (namespace) => ({
        namespace,
        expected: undefined,
      }),
    ),
  ])("validates the namespace %j", ({ namespace, expected }) => {
    vi.spyOn(os, "hostname").mockReturnValue("Peter's Mac.local");
    if (expected) {
      expect(resolveBackupNamespace(namespace)).toBe(expected);
    } else {
      expect(() => resolveBackupNamespace(namespace)).toThrow("Backup namespace");
    }
  });
});
