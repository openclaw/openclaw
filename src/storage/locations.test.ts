import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { StorageLocationConfig } from "../config/types.storage.js";
import { initStorageLocation, openStorageLocation, probeStorageLocation } from "./locations.js";
import { StorageLocationError } from "./marker.js";
import type { StorageRegistry } from "./provider.js";
import type { StorageBackend, StorageObjectInfo, StorageProvider } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const markerKey = "openclaw-storage.json";
const replacementMarker = Buffer.from(
  JSON.stringify({
    version: 1,
    locationId: "11111111-1111-4111-8111-111111111111",
    createdAt: 0,
    encryption: "none",
  }),
);

async function* bytes(value: Uint8Array | string) {
  yield typeof value === "string" ? Buffer.from(value) : value;
}

async function collect(body: AsyncIterable<Uint8Array> | undefined): Promise<Buffer> {
  if (!body) {
    throw new Error("Expected an object stream");
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function list(body: AsyncIterable<StorageObjectInfo>): Promise<StorageObjectInfo[]> {
  const objects: StorageObjectInfo[] = [];
  for await (const object of body) {
    objects.push(object);
  }
  return objects.toSorted((left, right) => left.key.localeCompare(right.key));
}

function configFor(location: StorageLocationConfig): OpenClawConfig {
  return { storage: { locations: { archive: location } } };
}

function filesystemParams(
  directory: string,
  encryption: StorageLocationConfig["encryption"] = "none",
) {
  return {
    name: "archive",
    config: configFor({ provider: "filesystem", settings: { path: directory }, encryption }),
  };
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
      for (const [key, content] of objects) {
        if (key.startsWith(prefix)) {
          yield { key, sizeBytes: content.length };
        }
      }
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
  return {
    provider,
    backend,
    objects,
    calls,
    params: {
      name: "archive",
      config: configFor({ provider: provider.id, settings: {}, encryption }),
      registry,
    },
  };
}

describe("storage locations", () => {
  it("lists and stats encrypted object sizes without GET requests", async () => {
    const fixture = memoryFixture({ passphrase: "example-storage-passphrase-not-real" });
    const location = await initStorageLocation(fixture.params);
    try {
      const scoped = location.scope("snapshots");
      const expected = [];
      for (const size of [0, 1, 1_048_576, 1_048_577, 3 * 1_048_576 + 17]) {
        const key = `${size}.bin`;
        await scoped.putObject(key, bytes(Buffer.alloc(size)), { sizeBytes: size });
        expected.push({
          key,
          sizeBytes: size,
          storedBytes: fixture.objects.get(`snapshots/${key}`)!.length,
        });
      }
      fixture.calls.length = 0;
      await expect(list(scoped.list())).resolves.toEqual(
        expected.toSorted((left, right) => left.key.localeCompare(right.key)),
      );
      for (const object of expected) {
        await expect(scoped.stat(object.key)).resolves.toEqual(object);
      }
      expect(fixture.calls.filter((call) => call === "get")).toEqual([]);
      await location.close();
      await expect(scoped.stat("0.bin")).rejects.toMatchObject({ state: "unavailable" });
      await expect(list(scoped.list())).rejects.toMatchObject({ state: "unavailable" });
    } finally {
      await location.close();
    }
  });

  it("skips foreign keys within the requested listing prefix", async () => {
    const fixture = memoryFixture();
    const location = await initStorageLocation(fixture.params);
    try {
      fixture.objects.set("snapshots/foreign object", Buffer.from("foreign"));
      fixture.objects.set("snapshots/../foreign", Buffer.from("foreign"));
      await location.scope("snapshots").putObject("valid.bin", bytes("valid"), {});
      await expect(list(location.scope("snapshots").list())).resolves.toEqual([
        { key: "valid.bin", sizeBytes: 5, storedBytes: 5 },
      ]);
    } finally {
      await location.close();
    }
  });

  it.each(["elsewhere/valid.bin", "elsewhere/foreign object"])(
    "rejects a provider listing outside the requested prefix: %s",
    async (key) => {
      const fixture = memoryFixture();
      const location = await initStorageLocation(fixture.params);
      try {
        fixture.backend.listObjects = async function* () {
          yield { key, sizeBytes: 0 };
        };
        await expect(list(location.scope("snapshots").list())).rejects.toThrow(
          "outside the requested prefix",
        );
      } finally {
        await location.close();
      }
    },
  );

  it("refuses runtime access to an uninitialized directory without creating anything", async () => {
    const directory = tempDirs.make("openclaw-storage-location-");
    const params = filesystemParams(directory);
    await expect(
      (async () => {
        const location = await openStorageLocation(params);
        try {
          await location.putObject("backup.bin", bytes("must not be written"), {});
        } finally {
          await location.close();
        }
      })(),
    ).rejects.toMatchObject({
      state: "unavailable",
      message: expect.stringContaining("openclaw storage init archive"),
    });
    await expect(probeStorageLocation(params)).resolves.toMatchObject({ state: "unavailable" });
    await expect(fs.readdir(directory)).resolves.toEqual([]);
  });

  it("requires an existing root during explicit initialization", async () => {
    const parent = tempDirs.make("openclaw-storage-location-");
    const directory = path.join(parent, "missing");
    await expect(initStorageLocation(filesystemParams(directory))).rejects.toMatchObject({
      name: "StorageLocationError",
      state: "unavailable",
      message:
        "Storage directory is unavailable. Reconnect the disk and check the configured path; storage init requires an existing directory.",
    });
    await expect(probeStorageLocation(filesystemParams(directory))).resolves.toMatchObject({
      state: "unavailable",
    });
    await expect(fs.readdir(parent)).resolves.toEqual([]);
  });

  it.each([
    { operation: "open", open: openStorageLocation },
    { operation: "init", open: initStorageLocation },
  ])("$operation sanitizes provider open and marker-read failures", async ({ open }) => {
    for (const failure of ["open", "marker-read", "marker-stream"] as const) {
      const fixture = memoryFixture();
      const providerError = new Error("provider failure with synthetic-private-credential");
      const close = vi.fn(async () => {});
      fixture.backend.close = close;
      if (failure === "open") {
        fixture.provider.open = async () => {
          throw providerError;
        };
      } else {
        fixture.backend.getObject = async () => {
          if (failure === "marker-read") {
            throw providerError;
          }
          return (async function* () {
            yield Buffer.from("{");
            throw providerError;
          })();
        };
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
      ...filesystemParams(directory, {
        passphrase: { source: "env", provider: "default", id: "STORAGE_TEST_PASSPHRASE" },
      }),
      env: { STORAGE_TEST_PASSPHRASE: "example-storage-passphrase-not-real" },
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

  it("keeps scoped streams plaintext while providers receive ciphertext and metadata uses logical sizes", async () => {
    const fixture = memoryFixture({ passphrase: "example-storage-passphrase-not-real" });
    const location = await initStorageLocation(fixture.params);
    try {
      const scoped = location.scope("snapshots").scope("first");
      const payload = Buffer.alloc(1_048_577, 0x5a);
      await expect(
        scoped.putObject("data.bin", bytes(payload), { sizeBytes: payload.length }),
      ).resolves.toMatchObject({ sizeBytes: payload.length, storedBytes: expect.any(Number) });
      await scoped.putObject("empty.bin", bytes(Buffer.alloc(0)), { sizeBytes: 0 });
      await location.scope("snapshots/second").putObject("other.bin", bytes("other"), {});
      const stored = fixture.objects.get("snapshots/first/data.bin");
      expect(stored?.subarray(0, 8).toString()).toBe("OCSTOR1\n");
      expect(stored?.includes(payload)).toBe(false);
      expect(await collect(await scoped.getObject("data.bin"))).toEqual(payload);
      expect(await collect(await scoped.getObject("empty.bin"))).toEqual(Buffer.alloc(0));
      await expect(scoped.stat("data.bin")).resolves.toEqual({
        key: "data.bin",
        sizeBytes: payload.length,
        storedBytes: stored!.length,
      });
      await expect(list(scoped.list())).resolves.toEqual([
        { key: "data.bin", sizeBytes: payload.length, storedBytes: stored!.length },
        {
          key: "empty.bin",
          sizeBytes: 0,
          storedBytes: fixture.objects.get("snapshots/first/empty.bin")!.length,
        },
      ]);
      expect((await list(location.list())).map((object) => object.key)).not.toContain(markerKey);
      await scoped.delete("data.bin");
      await expect(scoped.getObject("data.bin")).resolves.toBeUndefined();
      expect(fixture.objects.has("snapshots/second/other.bin")).toBe(true);
    } finally {
      await location.close();
    }
  });

  it("revokes an existing handle when its marker is replaced", async () => {
    const fixture = memoryFixture();
    const location = await initStorageLocation(fixture.params);
    try {
      fixture.objects.set(markerKey, replacementMarker);
      await expect(location.putObject("later.bin", bytes("blocked"), {})).rejects.toMatchObject({
        state: "unavailable",
      });
      await expect(location.probe()).resolves.toMatchObject({ state: "unavailable" });
      expect([...fixture.objects.keys()]).toEqual([markerKey]);
    } finally {
      await location.close();
    }
  });

  it("refuses publication if identity changes while consuming the upload", async () => {
    const fixture = memoryFixture();
    const location = await initStorageLocation(fixture.params);
    try {
      async function* interrupted() {
        yield Buffer.from("first bytes");
        fixture.objects.set(markerKey, replacementMarker);
        yield Buffer.from("last bytes");
      }
      await expect(location.putObject("later.bin", interrupted(), {})).rejects.toMatchObject({
        state: "unavailable",
      });
      expect([...fixture.objects.keys()]).toEqual([markerKey]);
    } finally {
      await location.close();
    }
  });

  it("validates keys and namespaces before calling the provider", async () => {
    const fixture = memoryFixture();
    const location = await initStorageLocation(fixture.params);
    try {
      fixture.calls.length = 0;
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
      expect(fixture.calls).toEqual([]);
    } finally {
      await location.close();
    }
  });
});
