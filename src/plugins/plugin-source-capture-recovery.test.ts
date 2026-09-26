import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as notes from "../../packages/terminal-core/src/note.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { noteLegacyPluginSourceCaptures } from "../commands/doctor-plugin-source-captures.js";
import * as census from "../infra/openclaw-process-census.js";
import { acquireGatewayMaintenanceCoordinator } from "../infra/state-database-coordinator.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import {
  createPluginNativeCaptureRoot,
  createPluginSourceCaptureRoot,
  retainPluginNativeCapturePath,
  retainPluginSourceCaptureInstance,
  sweepPluginSourceCaptureDirectories,
} from "./plugin-source-capture-directory.js";

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({ readCommand: async () => null }),
}));

const temp = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    clearPluginMetadataLifecycleCaches();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);
const hour = 60 * 60 * 1_000;

beforeEach(() => {
  const temporary = temp.make("capture-recovery-temp-");
  for (const key of ["TMPDIR", "TMP", "TEMP"]) {
    vi.stubEnv(key, temporary);
  }
  vi.spyOn(process, "emitWarning").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it("recovers a removed captures directory without releasing a live instance", async () => {
  const stateDir = temp.make("capture-recovery-missing-");
  const instance = retainPluginSourceCaptureInstance(stateDir);
  const first = instance.createDirectory();
  const captures = path.dirname(first);
  const root = path.dirname(captures);
  await sweepPluginSourceCaptureDirectories(stateDir);
  fs.rmSync(captures, { recursive: true });
  let worker: ReturnType<typeof createPluginSourceCaptureRoot> | undefined;
  try {
    worker = createPluginSourceCaptureRoot(stateDir, "openclaw-model-catalog-");
    fs.writeFileSync(path.join(worker.directory, "source.js"), "recovered capture");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * hour);
    await sweepPluginSourceCaptureDirectories(stateDir);
    expect(fs.readFileSync(path.join(worker.directory, "source.js"), "utf8")).toBe(
      "recovered capture",
    );
    await worker.release();
    expect(fs.existsSync(root)).toBe(true);
    const next = instance.createDirectory();
    expect(fs.readdirSync(captures)).toEqual([path.basename(next)]);
  } finally {
    await worker?.release();
    await instance.releaseAsync();
  }
  expect(fs.existsSync(root)).toBe(false);
});

it.each(["sync", "async"])(
  "keeps published native bytes across %s disposal and later ordinary sweeps",
  async (mode) => {
    const stateDir = temp.make("native-capture-retention-");
    const committed = createPluginNativeCaptureRoot(stateDir);
    const pending = createPluginNativeCaptureRoot(stateDir);
    const worker = createPluginSourceCaptureRoot(stateDir, "openclaw-model-catalog-");
    const payload = path.join(committed.directory, "package", "bin", "native");
    fs.mkdirSync(path.dirname(payload), { recursive: true });
    fs.writeFileSync(payload, "retained native bytes");
    fs.writeFileSync(path.join(pending.directory, "native"), "unpublished bytes");
    committed.commit();
    if (mode === "sync") {
      committed.dispose();
      pending.dispose();
    } else {
      await committed.disposeAsync();
      await pending.disposeAsync();
    }
    await worker.release();
    expect(fs.existsSync(pending.directory)).toBe(false);
    expect(fs.existsSync(worker.directory)).toBe(false);
    const instance = path.dirname(path.dirname(committed.directory));
    expect(fs.existsSync(path.join(instance, "owner.sqlite"))).toBe(true);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * hour);
    await sweepPluginSourceCaptureDirectories(stateDir);
    expect(fs.readFileSync(payload, "utf8")).toBe("retained native bytes");
    expect(fs.existsSync(path.join(instance, "owner.sqlite"))).toBe(true);
  },
);

it("reclaims only unreferenced native roots under maintenance while preserving live custody", async () => {
  const stateDir = temp.make("native-capture-maintenance-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const note = vi.spyOn(notes, "note").mockImplementation(() => {});
  const inspectProcesses = vi.spyOn(census, "inspectOtherOpenClawProcesses");
  const realpath = fsPromises.realpath.bind(fsPromises);
  vi.spyOn(fsPromises, "realpath").mockImplementation(async (target) =>
    realpath(String(target) === "/tmp" ? tmpdir() : target),
  );
  const runCaptureReport = async () => {
    note.mockClear();
    await noteLegacyPluginSourceCaptures(env, true);
    return note.mock.calls.map(([message]) => String(message)).join("\n");
  };
  const duringMaintenance = async () => {
    const lease = acquireGatewayMaintenanceCoordinator({
      databasePath: path.join(stateDir, "openclaw.sqlite"),
      runtimeDirectory: path.join(stateDir, "locks"),
    });
    const scope = createOpenClawDatabaseMaintenanceScope(lease.createSchemaFenceDelegate);
    try {
      return await scope.run(runCaptureReport);
    } finally {
      await scope.close();
      lease.release();
    }
  };
  const write = (root: string, filename: string, contents: string) => {
    const file = path.join(root, filename);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    return file;
  };
  const referenced = createPluginNativeCaptureRoot(stateDir);
  const captured = write(referenced.directory, "content/bin/native", "published native bytes");
  referenced.commit();
  referenced.dispose();
  const orphan = createPluginNativeCaptureRoot(stateDir);
  write(orphan.directory, "package/bin/native", "superseded native bytes");
  orphan.commit();
  orphan.dispose();
  const warm = createPluginNativeCaptureRoot(stateDir);
  const warmFile = write(warm.directory, "package/bin/native", "warm generation bytes");
  warm.commit();
  warm.dispose();
  const releaseWarm = retainPluginNativeCapturePath(warmFile);
  const live = createPluginNativeCaptureRoot(stateDir);
  const liveFile = write(live.directory, "package/bin/native", "currently in use");
  await writePersistedInstalledPluginIndex(
    {
      version: 1,
      hostContractVersion: "fixture",
      compatRegistryVersion: "fixture",
      migrationVersion: 1,
      policyHash: "fixture",
      generatedAtMs: Date.now(),
      installRecords: {},
      plugins: [
        {
          pluginId: "fixture",
          manifestPath: "/fixture/openclaw.plugin.json",
          manifestHash: "fixture",
          rootDir: "/fixture",
          origin: "global",
          enabled: true,
          startup: { sidecar: false, memory: false, agentHarnesses: [] },
          compat: [],
          sourceAdmissions: {
            fixture: {
              signature: "fixture",
              sourceDigest: "a".repeat(64),
              nativeArtifacts: {
                "bin/native": {
                  sourceIdentity: "fixture",
                  contentHash: "b".repeat(64),
                  sizeBytes: 22,
                  capturedPath: captured,
                  namespace: referenced.directory,
                  capturedIdentity: "fixture",
                },
              },
              nativeNamespaces: {
                [referenced.directory]: {
                  sourceDirectory: "/fixture",
                  capturedRoot: referenced.directory,
                  managed: false,
                  members: {
                    "bin/native": {
                      source: "/fixture/bin/native",
                      sourceIdentity: "fixture",
                      capturedIdentity: "fixture",
                      boundaryChecked: false,
                      contentHash: "b".repeat(64),
                      sizeBytes: 22,
                    },
                  },
                },
              },
            },
          },
        },
      ],
      diagnostics: [],
    },
    { stateDir },
  );
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1_000);
  try {
    inspectProcesses.mockReturnValue({ pids: [4242] });
    expect(await duringMaintenance()).toContain("PIDs: 4242");
    expect(fs.existsSync(orphan.directory)).toBe(true);
    inspectProcesses.mockReturnValue({ pids: [] });
    const output = await duringMaintenance();
    expect(output).toContain("Removed 1 unreferenced native plugin capture root(s).");
    expect(fs.existsSync(orphan.directory)).toBe(false);
    expect(fs.readFileSync(captured, "utf8")).toBe("published native bytes");
    expect(fs.readFileSync(warmFile, "utf8")).toBe("warm generation bytes");
    expect(fs.readFileSync(liveFile, "utf8")).toBe("currently in use");
    releaseWarm();
    await duringMaintenance();
    expect(fs.existsSync(warm.directory)).toBe(false);
  } finally {
    releaseWarm();
    live.dispose();
  }
});
