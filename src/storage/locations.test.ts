import fs from "node:fs/promises";
import "../test-utils/prepare-compiled-subprocesses.js";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { afterEach, assert, expect, it, onTestFinished, vi } from "vitest";
import { collect as list } from "../../test/helpers/async-iterable.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { StorageLocationConfig } from "../config/types.storage.js";
import { initStorageLocation, openStorageLocation, probeStorageLocation } from "./locations.js";
import { createStorageMarker } from "./marker.js";
import type { StorageRegistry } from "./provider.js";
import type { StorageBackend, StorageProvider } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const markerKey = "openclaw-storage.json";
const unavailable = { state: "unavailable" };
const passphrase = "example-storage-passphrase-not-real";

async function* bytes(value: Uint8Array | string) {
  yield typeof value === "string" ? Buffer.from(value) : value;
}

function paramsFor(location: StorageLocationConfig) {
  return { name: "archive", config: { storage: { locations: { archive: location } } } };
}

function filesystemParams(root: string, encryption: StorageLocationConfig["encryption"] = "none") {
  return paramsFor({ provider: "filesystem", settings: { path: root }, encryption });
}

function memoryFixture(encryption: StorageLocationConfig["encryption"] = "none") {
  const objects = new Map<string, Buffer>();
  const calls: string[] = [];
  const backend: StorageBackend = {
    displayTarget: "memory://example",
    probe: async () => ({ freeBytes: 4096, totalBytes: 8192 }),
    async putObject(key, body) {
      calls.push("put");
      const content = await buffer(body);
      assert(!objects.has(key), "Object already exists");
      objects.set(key, content);
      return { sizeBytes: content.length };
    },
    async getObject(key) {
      calls.push("get");
      return objects.has(key) ? bytes(objects.get(key)!) : undefined;
    },
    async statObject(key) {
      calls.push("stat");
      return objects.has(key) ? { key, sizeBytes: objects.get(key)!.length } : undefined;
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
  const data = Buffer.alloc(1_048_577, 0x5a);
  const written = await scoped.putObject("data.bin", bytes(data), { sizeBytes: data.length });
  const stored = objects.get("snapshots/first/data.bin")!;
  const expected = { key: "data.bin", sizeBytes: data.length, storedBytes: stored.length };
  expect(written).toEqual({ sizeBytes: data.length, storedBytes: stored.length });
  await location.scope("snapshots/second").putObject("other.bin", bytes("other"), {});
  calls.length = 0;
  await expect(list(scoped.list())).resolves.toEqual([expected]);
  await expect(scoped.stat("data.bin")).resolves.toEqual(expected);
  expect(calls.filter((call) => call === "get")).toEqual([]);
  expect(stored.subarray(0, 8).toString()).toBe("OCSTOR1\n");
  expect(stored.includes(data)).toBe(false);
  const body = await scoped.getObject("data.bin");
  assert(body, "Expected an object stream");
  expect(await buffer(body)).toEqual(data);
  expect((await list(location.list())).map((object) => object.key)).not.toContain(markerKey);
  await scoped.delete("data.bin");
  await expect(scoped.getObject("data.bin")).resolves.toBeUndefined();
  expect(objects.has("snapshots/second/other.bin")).toBe(true);
  await location.close();
  await expect(scoped.stat("data.bin")).rejects.toMatchObject(unavailable);
  await expect(list(scoped.list())).rejects.toMatchObject(unavailable);
});

it("skips foreign keys within the requested listing prefix", async () => {
  const { location, objects } = await initializedMemory();
  objects.set("snapshots/foreign object", Buffer.from("foreign"));
  objects.set("snapshots/../foreign", Buffer.from("foreign"));
  await location.scope("snapshots").putObject("valid.bin", bytes("valid"), {});
  await expect(list(location.scope("snapshots").list())).resolves.toEqual([
    { key: "valid.bin", sizeBytes: 5, storedBytes: 5 },
  ]);
});

it("rejects out-of-prefix listings before filtering invalid keys", async () => {
  const { location, backend } = await initializedMemory();
  backend.listObjects = async function* () {
    yield { key: "elsewhere/foreign object", sizeBytes: 0 };
  };
  await expect(list(location.scope("snapshots").list())).rejects.toThrow(
    "outside the requested prefix",
  );
});

it.each(["uninitialized", "missing"])("refuses a %s root", async (root) => {
  const parent = tempDirs.make("openclaw-storage-location-");
  const params = filesystemParams(root === "missing" ? path.join(parent, root) : parent);
  const open = root === "missing" ? initStorageLocation : openStorageLocation;
  await expect(open(params)).rejects.toMatchObject({
    ...unavailable,
    name: "StorageLocationError",
    message:
      root === "missing"
        ? "Storage directory is unavailable. Reconnect the disk and check the configured path; storage init requires an existing directory."
        : `Storage location "archive" (${parent}) has no initialization marker. If this is a new location, run \`openclaw storage init archive\`; otherwise reconnect the disk or check the bucket and prefix.`,
  });
  await expect(probeStorageLocation(params)).resolves.toMatchObject(unavailable);
  await expect(fs.readdir(parent)).resolves.toEqual([]);
});

it.each([openStorageLocation, initStorageLocation])("sanitizes %s failures", async (open) => {
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
    expect(error).toMatchObject({
      state: "error",
      message:
        "Storage could not be accessed. Check its provider settings, credentials, and connection.",
    });
    expect(close).toHaveBeenCalledTimes(failure === "open" ? 0 : 1);
  }
});

it("initializes idempotently with the same key and reports a wrong passphrase", async () => {
  const directory = tempDirs.make("openclaw-storage-location-");
  const env = { STORAGE_KEY: passphrase };
  const params = {
    ...filesystemParams(directory, {
      passphrase: { source: "env", provider: "default", id: "STORAGE_KEY" },
    }),
    env,
  };
  const first = await initStorageLocation(params);
  const identity = first.describe();
  await first.close();
  const marker = await fs.readFile(path.join(directory, markerKey));
  const second = await initStorageLocation(params);
  onTestFinished(() => second.close());
  expect(second.describe()).toEqual(identity);
  expect(identity.encrypted).toBe(true);
  await expect(second.probe()).resolves.toMatchObject({ state: "ok" });
  await expect(fs.readFile(path.join(directory, markerKey))).resolves.toEqual(marker);
  const wrongKey = { ...params, env: { STORAGE_KEY: "example-wrong-passphrase-not-real" } };
  await expect(probeStorageLocation(wrongKey)).resolves.toMatchObject({ state: "wrong-key" });
});

it.each(["before upload", "during upload"])("revokes identity replaced %s", async (timing) => {
  const { location, objects } = await initializedMemory();
  const marker = Buffer.from(JSON.stringify(await createStorageMarker("archive", undefined)));
  if (timing === "before upload") {
    objects.set(markerKey, marker);
  }
  async function* upload() {
    yield Buffer.from("first bytes");
    objects.set(markerKey, marker);
    yield Buffer.from("last bytes");
  }
  await expect(location.putObject("later.bin", upload(), {})).rejects.toMatchObject(unavailable);
  await expect(location.probe()).resolves.toMatchObject(unavailable);
  expect([...objects.keys()]).toEqual([markerKey]);
});

it("validates keys and namespaces before calling the provider", async () => {
  const { location, calls } = await initializedMemory();
  calls.length = 0;
  for (const key of ["", ".", "..", "a/../b", "back\\slash", "a".repeat(513)]) {
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
