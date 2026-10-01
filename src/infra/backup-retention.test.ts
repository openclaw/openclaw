import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeBackupRetention,
  resolveBackupNamespace,
  selectBackupRetention,
  type BackupRetention,
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
      label: "newest in each nonempty UTC day",
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
      label: "union of daily, weekly, and monthly buckets",
      policy: { keepDaily: 2, keepWeekly: 3, keepMonthly: 3 },
      kept: [
        "20270104T000100Z",
        "20270103T235900Z",
        "20261231T235900Z",
        "20261227T235900Z",
        "20261130T120000Z",
      ],
    },
  ])("keeps $label", ({ policy, kept }) => {
    const selected = selectBackupRetention(backups.toReversed(), policy);
    expect(selected.kept).toEqual(kept.map(key));
    expect(selected.deleted).toEqual(
      timestamps.filter((timestamp) => !kept.includes(timestamp)).map(key),
    );
  });

  it.each([{}, { keepDaily: 0 }])("never selects foreign or malformed keys with %j", (policy) => {
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
    const result = selectBackupRetention([...foreign, ...backups], policy);
    expect([...result.kept, ...result.deleted].toSorted()).toEqual(backups.toSorted());
    expect(result.kept[0]).toBe(backups[0]);
  });

  it("accepts zero and integer CLI counts", () => {
    expect(normalizeBackupRetention({ keepDaily: "7", keepWeekly: 0, keepMonthly: "12" })).toEqual({
      keepDaily: 7,
      keepWeekly: 0,
      keepMonthly: 12,
    });
  });

  it.each([
    { keepDaily: "" },
    { keepDaily: "-1" },
    { keepDaily: -1 },
    { keepWeekly: "1.5" },
    { keepMonthly: Infinity },
    { keepMonthly: Number.NaN },
    { keepDaily: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects unsafe retention counts %j", (options) => {
    expect(() => normalizeBackupRetention(options)).toThrow("must be a nonnegative integer");
  });
});

describe("backup namespaces", () => {
  it("sanitizes the default hostname and preserves explicit namespace identity", () => {
    vi.spyOn(os, "hostname").mockReturnValue("Peter's Mac.local");
    expect(resolveBackupNamespace()).toBe("Peter-s-Mac.local");
    expect(resolveBackupNamespace("Host_A-2.local")).toBe("Host_A-2.local");
  });

  it.each(["", ".", "..", "../other-host", "host/child", "host name", "a".repeat(129)])(
    "rejects non-segment namespace %j",
    (namespace) => {
      expect(() => resolveBackupNamespace(namespace)).toThrow("Backup namespace");
    },
  );
});
