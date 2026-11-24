import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { SQLITE_DATABASE_ADMISSIONS_KEY } from "./sqlite-database-admission-key.js";
import { isSqliteDatabaseAdmissionRetired } from "./sqlite-database-admission-record.js";
import { SqliteDatabaseAdmissionRegistry } from "./sqlite-database-admission-registry.js";
import {
  adoptSqliteDescriptor,
  isSqliteDescriptorCustodyClosed,
  isSqliteDescriptorCustodyOpen,
  retireSqliteDescriptorCustody,
} from "./sqlite-descriptor-custody.js";

const directories = useAutoCleanupTempDirTracker(afterEach);

function openPair() {
  const previousAdmissions = getEnvironmentData(SQLITE_DATABASE_ADMISSIONS_KEY);
  const location = path.join(directories.make("sqlite-custody-"), "database.sqlite");
  fs.writeFileSync(location, "");
  const descriptors = [fs.openSync(location, "r"), fs.openSync(location, "r")];
  const remaining = new Set(descriptors);
  const close = fs.closeSync;
  const closing = vi.spyOn(fs, "closeSync").mockImplementation((descriptor) => {
    close(descriptor);
    remaining.delete(descriptor);
  });
  const registry = new SqliteDatabaseAdmissionRegistry();
  const record = registry.retainDescriptor(
    location,
    descriptors[0]!,
    fs.fstatSync(descriptors[0]!, { bigint: true }),
  );
  const custody = registry.getDescriptorCustody(record.identity)!;
  const adopt = () =>
    registry.retainDescriptorCustody(
      location,
      descriptors[1]!,
      fs.fstatSync(descriptors[1]!, { bigint: true }),
    );
  return {
    location,
    descriptors,
    remaining,
    registry,
    record,
    custody,
    adopt,
    closing,
    close,
    [Symbol.dispose]() {
      closing.mockRestore();
      try {
        for (const descriptor of remaining) {
          close(descriptor);
        }
      } finally {
        setEnvironmentData(SQLITE_DATABASE_ADMISSIONS_KEY, previousAdmissions);
      }
    },
  };
}

it("keeps canonical custody across late adoption and natural generation retirement", () => {
  using fixture = openPair();
  const { registry, record, custody, descriptors } = fixture;
  const inherited = structuredClone(record.descriptorCustody);
  expect(fixture.adopt()).toBe(custody);
  expect(record.descriptor).toBe(descriptors[0]);
  registry.changeReferences(record, 1);
  registry.changeReferences(record, -1);
  expect(isSqliteDatabaseAdmissionRetired(record)).toBe(true);
  expect(isSqliteDescriptorCustodyOpen(inherited)).toBe(true);
  const next = registry.retainDescriptor(fixture.location, descriptors[1]!, custody.file);
  expect(next.generationId).not.toBe(record.generationId);
  expect(next.descriptor).toBe(record.descriptor);
  expect(next.descriptorCustody).toBe(record.descriptorCustody);
  expect(registry.getDescriptorCustody(next.identity)).toBe(custody);
  expect(retireSqliteDescriptorCustody(inherited, record.physicalIdentity, {})).toBe(true);
  expect(fixture.remaining.size).toBe(0);
  expect(isSqliteDatabaseAdmissionRetired(next)).toBe(true);
  registry.publish();
  expect(registry.descriptors.has(next.identity)).toBe(false);
});

it.runIf(process.platform === "linux")(
  "permits the owned pair but refuses a foreign same-file descriptor",
  () => {
    using fixture = openPair();
    fixture.adopt();
    const foreign = fs.openSync(fixture.location, "r");
    try {
      expect(
        fixture.registry.retireDescriptor(fixture.record.identity, { requireSoleDescriptor: true }),
      ).toBe(false);
      expect(fixture.remaining.size).toBe(2);
      expect(isSqliteDescriptorCustodyOpen(fixture.record.descriptorCustody)).toBe(true);
    } finally {
      fs.closeSync(foreign);
    }
    expect(
      fixture.registry.retireDescriptor(fixture.record.identity, { requireSoleDescriptor: true }),
    ).toBe(true);
    expect(fixture.remaining.size).toBe(0);
  },
);

it("retains both owned descriptors while another hardlink exists", () => {
  using fixture = openPair();
  fixture.adopt();
  const link = fixture.location + ".link";
  fs.linkSync(fixture.location, link);
  try {
    expect(fixture.registry.retireDescriptor(fixture.record.identity, {})).toBe(false);
    expect(fixture.remaining.size).toBe(2);
  } finally {
    fs.unlinkSync(link);
  }
  expect(fixture.registry.retireDescriptor(fixture.record.identity, {})).toBe(true);
});

it.runIf(process.platform === "linux")(
  "never lets an old snapshot retire a new physical epoch",
  () => {
    using fixture = openPair();
    fixture.adopt();
    const old = structuredClone(fixture.record.descriptorCustody);
    expect(fixture.registry.retireDescriptor(fixture.record.identity, {})).toBe(true);
    const replacement = fs.openSync(fixture.location, "r");
    fixture.remaining.add(replacement);
    const next = fixture.registry.retainDescriptor(
      fixture.location,
      replacement,
      fs.fstatSync(replacement, { bigint: true }),
    );
    expect(next.descriptorCustody.id).not.toBe(old.id);
    const closeCalls = fixture.closing.mock.calls.length;
    expect(retireSqliteDescriptorCustody(old, fixture.record.physicalIdentity, {})).toBe(false);
    expect(fixture.closing).toHaveBeenCalledTimes(closeCalls);
    expect(fs.fstatSync(replacement).isFile()).toBe(true);
    expect(fixture.registry.getDescriptorCustody(next.identity)?.descriptor).toBe(replacement);
    expect(fixture.registry.retireDescriptor(next.identity, {})).toBe(true);
  },
);

it.for([0, 1] as const)(
  "keeps failed custody without retrying a possibly closed slot %s",
  (failedSlot) => {
    using fixture = openPair();
    fixture.adopt();
    const failure = new Error("close completed with an uncertain result");
    fixture.closing.mockImplementation((descriptor) => {
      fixture.close(descriptor);
      fixture.remaining.delete(descriptor);
      if (descriptor === fixture.descriptors[failedSlot]) {
        throw failure;
      }
    });
    expect(() => fixture.registry.retireDescriptor(fixture.record.identity, {})).toThrow(failure);
    expect(isSqliteDatabaseAdmissionRetired(fixture.record)).toBe(true);
    expect(isSqliteDescriptorCustodyClosed(fixture.record.descriptorCustody)).toBe(false);
    fixture.registry.publish();
    expect(fixture.registry.descriptors.get(fixture.record.identity)).toBe(fixture.custody);
    const closes = fixture.closing.mock.calls.length;
    expect(() => fixture.registry.retireDescriptor(fixture.record.identity, {})).toThrow(
      /uncertain/,
    );
    expect(fixture.closing).toHaveBeenCalledTimes(closes);
    expect(() => fixture.registry.getDescriptorCustody(fixture.record.identity)).toThrow(
      /uncertain/,
    );
  },
);

it("prevalidates the complete pair before closing and excludes adoption during retirement", () => {
  using fixture = openPair();
  fixture.adopt();
  const stat = fs.fstatSync;
  const failure = new Error("second descriptor identity unavailable");
  using reading = vi.spyOn(fs, "fstatSync").mockImplementation((...args) => {
    expect(() =>
      adoptSqliteDescriptor(fixture.record.descriptorCustody, fixture.descriptors[0]!),
    ).toThrow(/not open/);
    if (args[0] === fixture.descriptors[1]) {
      throw failure;
    }
    return Reflect.apply(stat, fs, args);
  });
  expect(() => fixture.registry.retireDescriptor(fixture.record.identity, {})).toThrow(failure);
  expect(fixture.closing).not.toHaveBeenCalled();
  expect(fixture.remaining.size).toBe(2);
  assert(fixture.registry.descriptors.has(fixture.record.identity));
});
