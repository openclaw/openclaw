import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { StorageProvider } from "../../storage/types.js";
import { OpenClawCommand } from "./openclaw-command.js";
import { registerStorageCommand } from "./register.storage.js";

const fixture = vi.hoisted(() => {
  const config: OpenClawConfig = {};
  return {
    config,
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    acquire: vi.fn(),
    release: vi.fn(async () => {}),
  };
});

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  getRuntimeConfig: () => fixture.config,
}));
vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: fixture.runtime,
}));
vi.mock("../../storage/provider.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../storage/provider.js")>();
  return {
    ...original,
    acquireStorageProvider: (params: Parameters<typeof original.acquireStorageProvider>[0]) =>
      params.providerId === "filesystem" || params.registry
        ? original.acquireStorageProvider(params)
        : fixture.acquire(params),
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;

beforeEach(() => {
  vi.clearAllMocks();
  root = tempDirs.make("openclaw-storage-cli-");
  fixture.config = {
    storage: {
      locations: {
        archive: { provider: "filesystem", settings: { path: root }, encryption: "none" },
      },
    },
  };
});

async function runStorageCli(args: string[]) {
  const program = new OpenClawCommand();
  program.enablePositionalOptions();
  registerStorageCommand(program);
  await program.parseAsync(["storage", ...args], { from: "user" });
}

describe("storage CLI with filesystem transport", () => {
  it("initializes, verifies a probe round trip, deletes the probe, and lists availability", async () => {
    await runStorageCli(["--json", "init", "archive"]);
    expect(fixture.runtime.error).not.toHaveBeenCalled();
    expect(JSON.parse(String(fixture.runtime.log.mock.lastCall?.[0]))).toMatchObject({
      name: "archive",
      provider: "filesystem",
      state: "ok",
      encrypted: false,
    });

    await runStorageCli(["test", "archive", "--json"]);
    expect(fixture.runtime.error).not.toHaveBeenCalled();
    expect(JSON.parse(String(fixture.runtime.log.mock.lastCall?.[0]))).toMatchObject({
      name: "archive",
      state: "ok",
      sizeBytes: 256,
    });
    expect(await fs.readdir(root)).toEqual(["openclaw-storage.json"]);

    await runStorageCli(["list", "--json"]);
    expect(JSON.parse(String(fixture.runtime.log.mock.lastCall?.[0]))).toMatchObject({
      locations: [{ name: "archive", provider: "filesystem", state: "ok" }],
    });
    expect(fixture.runtime.exit).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "lists plugin display targets even when opening fails (json=%s)",
    async (json) => {
      const provider: StorageProvider = {
        id: "r2",
        label: "R2",
        describeTarget: (settings) => `r2://${String(settings.bucket)}/${String(settings.prefix)}`,
        open: async () => {
          throw new Error("synthetic-private-credential");
        },
      };
      fixture.config = {
        storage: {
          locations: {
            r2test: {
              provider: "r2",
              settings: { bucket: "bucket", prefix: "prefix" },
              encryption: "none",
            },
          },
        },
      };
      fixture.acquire.mockResolvedValue({
        provider,
        registry: {
          storageProviders: new Map([["r2", { pluginId: "cloudflare", source: "test", provider }]]),
        },
        release: fixture.release,
      });
      await runStorageCli(["list", ...(json ? ["--json"] : [])]);
      if (json) {
        expect(JSON.parse(String(fixture.runtime.log.mock.lastCall?.[0]))).toMatchObject({
          locations: [
            { name: "r2test", provider: "r2", displayTarget: "r2://bucket/prefix", state: "error" },
          ],
        });
      } else {
        expect(fixture.runtime.log).toHaveBeenCalledWith(
          expect.stringContaining("r2test (r2): error — r2://bucket/prefix"),
        );
      }
      expect(fixture.runtime.log.mock.calls.flat().join(" ")).not.toContain(
        "synthetic-private-credential",
      );
      expect(fixture.acquire).toHaveBeenCalledTimes(1);
      expect(fixture.release).toHaveBeenCalledTimes(1);
    },
  );

  it("refuses to test an uninitialized location without writing anything", async () => {
    await runStorageCli(["test", "archive"]);
    expect(fixture.runtime.exit).toHaveBeenCalledWith(1);
    expect(fixture.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("storage init archive"),
    );
    expect(await fs.readdir(root)).toEqual([]);
  });
});
