import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareSqliteReadOnlyLocationSyncInProcess } from "./sqlite-readonly-location.js";
import { readDatabasePathIdentitySync } from "./sqlite-worker-identity.js";

const directories = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });
});

function fixture() {
  const root = directories.make("sqlite-copy-source-identity-");
  const source = path.join(root, "source.sqlite");
  const replacement = path.join(root, "replacement.sqlite");
  const archived = path.join(root, "original.sqlite");
  const staging = path.join(root, "staging");
  const bytes = Buffer.alloc(4099, 42);
  fs.mkdirSync(staging);
  fs.writeFileSync(source, bytes);
  fs.writeFileSync(replacement, bytes);
  return { source, replacement, archived, staging, bytes };
}

it("copies the admitted source and rejects an identical successor at every observed main open", () => {
  const files = fixture();
  const identity = readDatabasePathIdentitySync(files.source);
  expect(readDatabasePathIdentitySync(files.replacement).key).not.toBe(identity.key);
  const canonicalSource = fs.realpathSync.native(files.source);
  const open = fs.openSync.bind(fs);
  const close = fs.closeSync.bind(fs);
  let observedOpens = 0;
  const census = vi.spyOn(fs, "openSync").mockImplementation((pathname, flags, mode) => {
    const descriptor = open(pathname, flags, mode);
    if (String(pathname) === canonicalSource) {
      observedOpens += 1;
    }
    return descriptor;
  });
  let baseline: ReturnType<typeof prepareSqliteReadOnlyLocationSyncInProcess>;
  try {
    baseline = prepareSqliteReadOnlyLocationSyncInProcess(files.source, files.staging, identity);
  } finally {
    census.mockRestore();
  }
  try {
    expect(fs.readFileSync(baseline.location)).toEqual(files.bytes);
    expect(fs.readFileSync(files.source)).toEqual(files.bytes);
    expect(readDatabasePathIdentitySync(files.source)).toEqual(identity);
  } finally {
    expect(baseline.cleanup()).toBe(true);
  }
  expect(observedOpens).toBeGreaterThanOrEqual(1);
  expect(fs.readdirSync(files.staging)).toEqual([]);

  for (let targetOpen = 1; targetOpen <= observedOpens; targetOpen += 1) {
    const label = `main descriptor ${targetOpen} of ${observedOpens}`;
    let sourceOpens = 0;
    let replacementDescriptor: number | undefined;
    let injected = false;
    // Keep the successor installed for the real descriptor's entire lifetime;
    // the original pathname identity is restored before overall acceptance.
    const opening = vi.spyOn(fs, "openSync").mockImplementation((pathname, flags, mode) => {
      if (String(pathname) === canonicalSource && ++sourceOpens === targetOpen) {
        fs.renameSync(files.source, files.archived);
        fs.renameSync(files.replacement, files.source);
        injected = true;
        replacementDescriptor = open(pathname, flags, mode);
        return replacementDescriptor;
      }
      return open(pathname, flags, mode);
    });
    const closing = vi.spyOn(fs, "closeSync").mockImplementation((descriptor) => {
      close(descriptor);
      if (descriptor === replacementDescriptor) {
        replacementDescriptor = undefined;
        fs.renameSync(files.source, files.replacement);
        fs.renameSync(files.archived, files.source);
      }
    });
    const wait = vi.spyOn(Atomics, "wait");
    let prepared: ReturnType<typeof prepareSqliteReadOnlyLocationSyncInProcess> | undefined;
    let failure: unknown;
    try {
      try {
        prepared = prepareSqliteReadOnlyLocationSyncInProcess(
          files.source,
          files.staging,
          identity,
        );
      } catch (error) {
        failure = error;
      } finally {
        if (prepared) {
          expect(prepared.cleanup(), label).toBe(true);
        }
      }
      expect(injected, label).toBe(true);
      expect(failure, label).toBeInstanceOf(Error);
      expect(failure, label).toHaveProperty(
        "message",
        expect.stringMatching(/file identity changed/),
      );
      expect(wait, label).not.toHaveBeenCalled();
      expect(replacementDescriptor, label).toBeUndefined();
      expect(readDatabasePathIdentitySync(files.source), label).toEqual(identity);
      expect(fs.readFileSync(files.source), label).toEqual(files.bytes);
      expect(fs.readFileSync(files.replacement), label).toEqual(files.bytes);
      expect(fs.readdirSync(files.staging), label).toEqual([]);
    } finally {
      opening.mockRestore();
      closing.mockRestore();
      wait.mockRestore();
    }
  }
});
