import fs from "node:fs/promises";
import "../test-utils/prepare-compiled-subprocesses.js";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { collect as collectItems } from "../../test/helpers/async-iterable.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { StorageLocationConfig } from "../config/types.storage.js";
import { initStorageLocation, openStorageLocation, probeStorageLocation } from "./locations.js";
import { createStorageMarker, StorageLocationError } from "./marker.js";
import type { StorageRegistry } from "./provider.js";
import type { StorageBackend, StorageObjectInfo, StorageProvider } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const markerKey = "openclaw-storage.json";
const unavailable = { state: "unavailable" };
const passphrase = "example-storage-passphrase-not-real";

async function* bytes(value: Uint8Array | string) {
  yield typeof value === "string" ? Buffer.from(value) : value;
}

async function collect(body: AsyncIterable<Uint8Array> | undefined): Promise<Buffer> {
  if (!body) {
    throw new Error("Expected an object stream");
  }
  return buffer(body);
}

async function list(body: AsyncIterable<StorageObjectInfo>): Promise<StorageObjectInfo[]> {
  return (await collectItems(body)).toSorted((left, right) => left.key.localeCompare(right.key));
}

function objectInfo(key: string, sizeBytes: number, storedBytes = sizeBytes) {
  return { key, sizeBytes, storedBytes };
}

function paramsFor(location: StorageLocationConfig) {
  return { name: "archive", config: { storage: { locations: { archive: location } } } };
}

function memoryFixture(encryption: StorageLocationConfig["encryption"] = "none") {
  const objects = new Map<string, Buffer>();
  const calls: string[] = [];
  const backend: StorageBackend = {
    displayTarget: "memory://example",
    async probe() {
      calls.push("probe");
      return { freeBytes: 4096, totalBytes: 8192 };
    },
    async putObject(key, body) {
      calls.push("put");
      const content = await collect(body);
      if (objects.has(key)) {
        throw new Error("Object already exists");
      }
      objects.set(key, content);
      return { sizeBytes: content.length };
    },
    async getObject(key) {
      calls.push("get");
      const content = objects.get(key);
      return content === undefined ? undefined : bytes(content);
    },
    async statObject(key) {
      calls.push("stat");
      const content = objects.get(key);
      return content === undefined ? undefined : { key, sizeBytes: content.length };
    },
    async *listObjects(prefix) {
      calls.push("list");
      yield* [...objects]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, content]) => ({ key, sizeBytes: content.length }));
    },
    async deleteObject(key) {
      calls.push("delete");
      objects.delete(key);
    },
  };
  const provider: StorageProvider = { id: "memory", label: "Memory", open: async () => backend };
  const registry: StorageRegistry = {
    storageProviders: new Map([[provider.id, { pluginId: "example", source: "test", provider }]]),
  };
  const params = { ...paramsFor({ provider: provider.id, settings: {}, encryption }), registry };
  return { provider, backend, objects, calls, params };
}

async function initializedMemory(encryption: StorageLocationConfig["encryption"] = "none") {
  const fixture = memoryFixture(encryption);
  const location = await initStorageLocation(fixture.params);
  onTestFinished(() => location.close());
  return { ...fixture, location };
}

it("round-trips scoped encrypted streams with logical metadata and no GETs for list/stat", async () => {
  const { location, objects, calls } = await initializedMemory({ passphrase });
  const scoped = location.scope("snapshots").scope("first");
  const expected = [];
  for (const size of [0, 1, 1_048_576, 1_048_577, 3 * 1_048_576 + 17]) {
    const key = `${size}.bin`;
    const written = await scoped.putObject(key, bytes(Buffer.alloc(size, 0x5a)), {
      sizeBytes: size,
    });
    expect(written).toMatchObject({ sizeBytes: size, storedBytes: expect.any(Number) });
    expected.push(objectInfo(key, size, objects.get(`snapshots/first/${key}`)!.length));
  }
  await location.scope("snapshots/second").putObject("other.bin", bytes("other"), {});
  calls.length = 0;
  expected.sort((left, right) => left.key.localeCompare(right.key));
  await expect(list(scoped.list())).resolves.toEqual(expected);
  for (const object of expected) {
    await expect(scoped.stat(object.key)).resolves.toEqual(object);
  }
  expect(calls.filter((call) => call === "get")).toEqual([]);
  const stored = objects.get("snapshots/first/1048577.bin");
  expect(stored?.subarray(0, 8).toString()).toBe("OCSTOR1\n");
  expect(stored?.includes(Buffer.alloc(1_048_577, 0x5a))).toBe(false);
  for (const { key, sizeBytes } of expected) {
    expect(await collect(await scoped.getObject(key))).toEqual(Buffer.alloc(sizeBytes, 0x5a));
  }
  expect((await list(location.list())).map((object) => object.key)).not.toContain(markerKey);
  await scoped.delete("1048577.bin");
  await expect(scoped.getObject("1048577.bin")).resolves.toBeUndefined();
  expect(objects.has("snapshots/second/other.bin")).toBe(true);
  await location.close();
  await expect(scoped.stat("0.bin")).rejects.toMatchObject(unavailable);
  await expect(list(scoped.list())).rejects.toMatchObject(unavailable);
});

it("skips foreign keys within the requested listing prefix", async () => {
  const { location, objects } = await initializedMemory();
  objects.set("snapshots/foreign object", Buffer.from("foreign"));
  objects.set("snapshots/../foreign", Buffer.from("foreign"));
  await location.scope("snapshots").putObject("valid.bin", bytes("valid"), {});
  await expect(list(location.scope("snapshots").list())).resolves.toEqual([
    objectInfo("valid.bin", 5),
  ]);
});

it.each(["elsewhere/valid.bin", "elsewhere/foreign object"])(
  "rejects a provider listing outside the requested prefix: %s",
  async (key) => {
    const { location, backend } = await initializedMemory();
    backend.listObjects = async function* () {
      yield { key, sizeBytes: 0 };
    };
    await expect(list(location.scope("snapshots").list())).rejects.toThrow(
      "outside the requested prefix",
    );
  },
);

it.each([
  { root: "uninitialized", open: openStorageLocation },
  { root: "missing", open: initStorageLocation },
])("refuses a $root root without creating anything", async ({ root, open }) => {
  const parent = tempDirs.make("openclaw-storage-location-");
  const params = paramsFor({
    provider: "filesystem",
    encryption: "none",
    settings: { path: root === "missing" ? path.join(parent, root) : parent },
  });
  await expect(open(params)).rejects.toMatchObject({
    ...unavailable,
    name: "StorageLocationError",
    message:
      root === "missing"
        ? "Storage directory is unavailable. Reconnect the disk and check the configured path; storage init requires an existing directory."
        : expect.stringContaining("openclaw storage init archive"),
  });
  await expect(probeStorageLocation(params)).resolves.toMatchObject(unavailable);
  await expect(fs.readdir(parent)).resolves.toEqual([]);
});

it.each([
  { operation: "open", open: openStorageLocation },
  { operation: "init", open: initStorageLocation },
])("$operation sanitizes provider open and marker-read failures", async ({ open }) => {
  for (const failure of ["open", "marker-read", "marker-stream"] as const) {
    const fixture = memoryFixture();
    const fail = () => Promise.reject(new Error("synthetic-private-credential"));
    const close = vi.fn(async () => {});
    fixture.backend.close = close;
    async function* brokenStream() {
      yield Buffer.from("{");
      await fail();
    }
    if (failure === "open") {
      fixture.provider.open = fail;
    } else {
      fixture.backend.getObject = failure === "marker-read" ? fail : async () => brokenStream();
    }
    const error = await open(fixture.params).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StorageLocationError);
    expect(error).toMatchObject({
      state: "error",
      message:
        "Storage could not be accessed. Check its provider settings, credentials, and connection.",
    });
    expect(close).toHaveBeenCalledTimes(failure === "open" ? 0 : 1);
  }
});

it("names the display target and recovery options for a missing object-store marker", async () => {
  const fixture = memoryFixture();
  fixture.backend.displayTarget = "r2://bucket/prefix";
  await expect(openStorageLocation(fixture.params)).rejects.toMatchObject({
    state: "unavailable",
    message:
      'Storage location "archive" (r2://bucket/prefix) has no initialization marker. If this is a new location, run `openclaw storage init archive`; otherwise reconnect the disk or check the bucket and prefix.',
  });
});

it("initializes idempotently with the same key and reports a wrong passphrase", async () => {
  const directory = tempDirs.make("openclaw-storage-location-");
  const params = {
    ...paramsFor({
      provider: "filesystem",
      settings: { path: directory },
      encryption: {
        passphrase: { source: "env", provider: "default", id: "STORAGE_TEST_PASSPHRASE" },
      },
    }),
    env: { STORAGE_TEST_PASSPHRASE: passphrase },
  };
  const first = await initStorageLocation(params);
  const identity = first.describe();
  await first.close();
  const marker = await fs.readFile(path.join(directory, markerKey));
  const second = await initStorageLocation(params);
  try {
    expect(second.describe()).toEqual(identity);
    expect(identity.encrypted).toBe(true);
    await expect(second.probe()).resolves.toMatchObject({ state: "ok" });
  } finally {
    await second.close();
  }
  await expect(fs.readFile(path.join(directory, markerKey))).resolves.toEqual(marker);
  await expect(
    probeStorageLocation({
      ...params,
      env: { STORAGE_TEST_PASSPHRASE: "example-wrong-passphrase-not-real" },
    }),
  ).resolves.toMatchObject({ state: "wrong-key" });
});

it.each(["before upload", "during upload"])("revokes identity replaced %s", async (timing) => {
  const { location, objects } = await initializedMemory();
  const replacementMarker = Buffer.from(
    JSON.stringify(await createStorageMarker("archive", undefined)),
  );
  if (timing === "before upload") {
    objects.set(markerKey, replacementMarker);
  }
  async function* interrupted() {
    yield Buffer.from("first bytes");
    objects.set(markerKey, replacementMarker);
    yield Buffer.from("last bytes");
  }
  await expect(location.putObject("later.bin", interrupted(), {})).rejects.toMatchObject(
    unavailable,
  );
  await expect(location.probe()).resolves.toMatchObject(unavailable);
  expect([...objects.keys()]).toEqual([markerKey]);
});

it("validates keys and namespaces before calling the provider", async () => {
  const { location, calls } = await initializedMemory();
  calls.length = 0;
  for (const key of [
    "",
    ".",
    "..",
    "a/../b",
    "/absolute",
    "back\\slash",
    "empty//segment",
    "trailing/",
    "a".repeat(513),
  ]) {
    await expect(location.putObject(key, bytes("blocked"), {})).rejects.toThrow();
    await expect(location.getObject(key)).rejects.toThrow();
    await expect(location.stat(key)).rejects.toThrow();
    await expect(location.delete(key)).rejects.toThrow();
    expect(() => location.scope(key)).toThrow();
  }
  await expect(list(location.list("invalid//prefix"))).rejects.toThrow();
  await expect(location.delete(markerKey)).rejects.toThrow("reserved");
  expect(calls).toEqual([]);
});
