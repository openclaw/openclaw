import "../../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { StorageLocationConfig } from "../../config/types.storage.js";
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
  captureRuntimeConfigAsyncReader: () => async () => fixture.config,
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
const { runtime, acquire, release } = fixture;
let root: string;

beforeEach(() => {
  vi.clearAllMocks();
  root = tempDirs.make("openclaw-storage-cli-");
  configureLocation("archive", "filesystem", { path: root });
});

async function runStorageCli(args: string) {
  const program = new OpenClawCommand();
  program.enablePositionalOptions();
  registerStorageCommand(program);
  await program.parseAsync(["storage", ...args.split(" ")], { from: "user" });
}

async function expectJson(args: string, expected: object) {
  await runStorageCli(args);
  expect(runtime.error).not.toHaveBeenCalled();
  expect(JSON.parse(String(runtime.log.mock.lastCall?.[0]))).toMatchObject(expected);
}

function configureLocation(
  name: string,
  provider: string,
  settings: StorageLocationConfig["settings"],
) {
  fixture.config = {
    storage: { locations: { [name]: { provider, settings, encryption: "none" } } },
  };
}

describe("storage CLI with filesystem transport", () => {
  it("initializes, verifies a probe round trip, deletes the probe, and lists availability", async () => {
    await expectJson("--json init archive", {
      name: "archive",
      provider: "filesystem",
      state: "ok",
      encrypted: false,
    });

    await expectJson("test archive --json", { name: "archive", state: "ok", sizeBytes: 256 });
    expect(await fs.readdir(root)).toEqual(["openclaw-storage.json"]);

    await expectJson("list --json", {
      locations: [{ name: "archive", provider: "filesystem", state: "ok" }],
    });
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it.each([false, true])("lists targets and redacts open failures (json=%s)", async (json) => {
    const provider: StorageProvider = {
      id: "r2",
      label: "R2",
      describeTarget: (settings) => `r2://${String(settings.bucket)}/${String(settings.prefix)}`,
      open: async () => {
        throw new Error("synthetic-private-credential");
      },
    };
    configureLocation("r2test", "r2", { bucket: "bucket", prefix: "prefix" });
    acquire.mockResolvedValue({
      provider,
      registry: {
        storageProviders: new Map([["r2", { pluginId: "cloudflare", source: "test", provider }]]),
      },
      release,
    });
    if (json) {
      await expectJson("list --json", {
        locations: [
          { name: "r2test", provider: "r2", displayTarget: "r2://bucket/prefix", state: "error" },
        ],
      });
    } else {
      await runStorageCli("list");
      expect(runtime.log).toHaveBeenCalledWith(
        expect.stringContaining("r2test (r2): error — r2://bucket/prefix"),
      );
    }
    expect(runtime.log.mock.calls.flat().join(" ")).not.toContain("synthetic-private-credential");
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("refuses to test an uninitialized location without writing anything", async () => {
    await runStorageCli("test archive");
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("storage init archive"));
    expect(await fs.readdir(root)).toEqual([]);
  });
});
