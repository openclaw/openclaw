import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireDistArtifactOwnership } from "../../../scripts/lib/dist-artifact-lock.mts";
import { installPrivateUpdateHandoffStore } from "../../../test/helpers/private-update-handoff-store.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  createPluginInstallRecordMap,
  getPluginInstallRecordMapEntry,
  setPluginInstallRecordMapEntry,
} from "../../config/plugin-install-record-map.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { isPidAlive } from "../../shared/pid-alive.js";
import { killPidIfAlive, readPidFile, waitForPidToExit } from "../../test-utils/process-tree.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { createPostCorePluginUpdateResult } from "./update-command-plugins-internals.js";
import {
  continuePostCoreUpdateInFreshProcess,
  preparePostCorePluginInstallRecordsForFreshProcess,
  resolvePostCoreUpdateHandoff,
  readPostCorePluginInstallRecordsFile,
  shouldResumePostCoreUpdateInFreshProcess,
  writePostCorePluginInstallRecordsFile,
  writePostCorePluginUpdateResultFile,
  writePostCoreUpdateFailureFile,
} from "./update-command-post-core.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const pluginUpdate = createPostCorePluginUpdateResult({ status: "ok", changed: true });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const withTempDir = () => tempDirs.make("openclaw-post-core-records-");

describe("continuePostCoreUpdateInFreshProcess", () => {
  it.each([false, true])(
    "releases artifact ownership only for a target without the prepared-fact consumer (modern=%s)",
    async (modern) => {
      vi.stubEnv("OPENCLAW_COMPATIBILITY_HOST_VERSION", "stale-version");
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL", "beta");
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH", "/tmp/stale-config.json");
      vi.stubEnv("OPENCLAW_TEST_POST_CORE_UNRELATED", "preserved");
      const root = withTempDir();
      const control = path.join(root, "control");
      await fs.mkdir(control, { mode: 0o700 });
      installPrivateUpdateHandoffStore(control);
      const observation = path.join(root, "ownership.txt");
      await fs.mkdir(path.join(root, "dist"));
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify(modern ? { version: "9999.0.0" } : {}),
      );
      if (modern) {
        await fs.mkdir(path.join(root, "scripts", "lib"), { recursive: true });
        await fs.writeFile(
          path.join(root, "scripts", "lib", "source-update-artifact-preflight.mts"),
          "export {};\n",
        );
      }
      const lockModule = new URL("../../../scripts/lib/dist-artifact-lock.mts", import.meta.url)
        .href;
      await fs.writeFile(
        path.join(root, "dist", "entry.mjs"),
        `import fs from "node:fs/promises";
import { acquireDistArtifactOwnership } from ${JSON.stringify(lockModule)};
let observed;
try {
  const lock = await acquireDistArtifactOwnership(${JSON.stringify(root)});
  await lock.release();
  observed = "child-acquired";
} catch (error) {
  if (!String(error).includes(${JSON.stringify(`retained by PID ${process.pid}`)})) throw error;
  observed = "parent-held";
}
await fs.writeFile(${JSON.stringify(observation)}, JSON.stringify({
  ownership: observed,
  compatHostVersion: process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION,
  requestedChannel: process.env.OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL,
  sourceConfigPath: process.env.OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH,
  unrelated: process.env.OPENCLAW_TEST_POST_CORE_UNRELATED,
}));
await fs.writeFile(process.env.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH, ${JSON.stringify(JSON.stringify(pluginUpdate))});
`,
      );
      const sourceArtifactLock = await acquireDistArtifactOwnership(root);
      try {
        const runId = "fixture-source-lock";
        const result = await withUpdateCommandExecutor(runId, async (executor) => {
          const executorFence = await executor.enter(root);
          return await continuePostCoreUpdateInFreshProcess({
            root,
            sourceRuntimePrepared: true,
            channel: "dev",
            requestedChannel: null,
            opts: {
              json: true,
              run: { runId, env: {}, sourceArtifactLock, executorFence },
            },
            pluginInstallRecords: {},
            updateStartedAtMs: Date.now(),
            timeoutMs: 5000,
            nodeRunner: process.execPath,
          });
        });
        expect(result).toEqual({ resumed: true, pluginUpdate });
        expect(JSON.parse(await fs.readFile(observation, "utf8"))).toEqual({
          ownership: modern ? "parent-held" : "child-acquired",
          ...(modern ? { compatHostVersion: "9999.0.0" } : {}),
          unrelated: "preserved",
        });
        expect(process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBe("stale-version");
        expect(process.env.OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL).toBe("beta");
        expect(process.env.OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH).toBe(
          "/tmp/stale-config.json",
        );
        expect(await sourceArtifactLock.verifyStillHeld()).toBe(modern);
      } finally {
        await sourceArtifactLock.release();
      }
    },
  );

  it.runIf(process.platform !== "win32").each([true, false])(
    "waits for a committed child's shutdown before returning its result (cooperative=%s)",
    async (cooperative) => {
      vi.stubEnv("OPENCLAW_COMPATIBILITY_HOST_VERSION", "stale-version");
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL", "beta");
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH", "/tmp/stale-config.json");
      vi.stubEnv("OPENCLAW_TEST_POST_CORE_UNRELATED", "preserved");
      const root = withTempDir();
      const settledPath = path.join(root, "settled");
      const pidPath = path.join(root, "writer.pid");
      const argvPath = path.join(root, "argv.json");
      const handoffPath = path.join(root, "handoff-observation.json");
      const pluginInstallRecords: Record<string, PluginInstallRecord> = {
        demo: { source: "npm", spec: "@openclaw/demo@1.0.0" },
      };
      const preUpdateConfig = {
        sourceConfig: { gateway: { port: 18789 } },
        authoredConfig: { gateway: { port: 18790 } },
      };
      await fs.mkdir(path.join(root, "dist"));
      await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "9999.0.0" }));
      await fs.writeFile(
        path.join(root, "dist", "entry.mjs"),
        `import fs from "node:fs/promises";
import path from "node:path";
const hold = setInterval(() => {}, 1000);
setTimeout(() => process.exit(2), 10000).unref();
process.once("SIGTERM", () => {
  if (!${JSON.stringify(cooperative)}) return;
  setTimeout(async () => {
    await fs.writeFile(${JSON.stringify(settledPath)}, "settled");
    clearInterval(hold);
  }, 150);
});
await fs.writeFile(${JSON.stringify(pidPath)}, String(process.pid));
await fs.writeFile(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));
const resultDir = path.dirname(process.env.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH);
await fs.writeFile(${JSON.stringify(handoffPath)}, JSON.stringify({
  resultDir,
  mode: (await fs.stat(resultDir)).mode & 0o777,
  marker: JSON.parse(await fs.readFile(path.join(resultDir, "handoff.json"), "utf8")),
  installRecords: await fs.readFile(process.env.OPENCLAW_UPDATE_POST_CORE_INSTALL_RECORDS_PATH, "utf8"),
  sourceConfig: await fs.readFile(process.env.OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH, "utf8"),
  compatHostVersion: process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION,
  requestedChannel: process.env.OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL ?? null,
}));
await fs.writeFile(process.env.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH, ${JSON.stringify(JSON.stringify(pluginUpdate))});
`,
      );

      let settledAtReturn: string | undefined;
      let aliveAtReturn: boolean | undefined;
      let result: Awaited<ReturnType<typeof continuePostCoreUpdateInFreshProcess>>;
      try {
        result = await continuePostCoreUpdateInFreshProcess({
          root,
          sourceRuntimePrepared: true,
          channel: "stable",
          requestedChannel: cooperative ? "dev" : null,
          opts: { json: true, yes: true, timeout: cooperative ? undefined : "3600" },
          pluginInstallRecords,
          preUpdateConfig,
          updateStartedAtMs: Date.now(),
          timeoutMs: 5000,
          nodeRunner: process.execPath,
        });
        settledAtReturn = await fs.readFile(settledPath, "utf8").catch(() => undefined);
        aliveAtReturn = isPidAlive(await readPidFile(pidPath));
      } finally {
        // Join the real fixture even on the unsafe baseline before temp cleanup.
        const pid = await readPidFile(pidPath);
        if (cooperative) {
          await expect
            .poll(() => fs.readFile(settledPath, "utf8").catch(() => undefined), { timeout: 5000 })
            .toBe("settled");
        }
        killPidIfAlive(pid);
        expect(await waitForPidToExit(pid)).toBe(true);
      }
      expect(result).toEqual({ resumed: true, pluginUpdate });
      expect(JSON.parse(await fs.readFile(argvPath, "utf8"))).toEqual([
        "update",
        "--json",
        "--yes",
        "--timeout",
        cooperative ? "5" : "3600",
      ]);
      expect(aliveAtReturn).toBe(false);
      expect(settledAtReturn).toBe(cooperative ? "settled" : undefined);
      const handoff = JSON.parse(await fs.readFile(handoffPath, "utf8"));
      expect(handoff).toEqual({
        resultDir: expect.any(String),
        mode: 0o700,
        marker: {
          completionOwner: "parent",
          sourceRuntimePrepared: true,
          timeout: {
            version: 1,
            serialized: cooperative ? "5" : "3600",
            operator: cooperative ? null : "3600",
          },
        },
        installRecords: `${JSON.stringify(pluginInstallRecords)}\n`,
        sourceConfig: `${JSON.stringify(preUpdateConfig)}\n`,
        compatHostVersion: "9999.0.0",
        requestedChannel: cooperative ? "dev" : null,
      });
      await expect(fs.stat(handoff.resultDir)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});

describe("post-core result publication", () => {
  it.runIf(process.platform !== "win32").each(["success", "failure"] as const)(
    "keeps the handoff private after publishing %s",
    async (outcome) => {
      const dir = withTempDir();
      await fs.chmod(dir, 0o700);
      const siblingPath = path.join(dir, "source-config.json");
      const sibling = '{"sourceConfig":{"gateway":{"port":18789}}}\n';
      await fs.writeFile(siblingPath, sibling);
      const resultPath = path.join(dir, "plugins.json");
      if (outcome === "success") {
        await writePostCorePluginUpdateResultFile(resultPath, pluginUpdate);
      } else {
        await writePostCoreUpdateFailureFile(resultPath, new Error("Plugin finalization failed"));
      }
      expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
      expect(await fs.readFile(siblingPath, "utf8")).toBe(sibling);
      expect(JSON.parse(await fs.readFile(resultPath, "utf8"))).toEqual(
        outcome === "success"
          ? pluginUpdate
          : { status: "failed", error: "Plugin finalization failed" },
      );
    },
  );
});

describe("readPostCorePluginInstallRecordsFile", () => {
  it.each([
    { kind: "omitted", raw: undefined, reason: undefined },
    { kind: "missing", raw: undefined, reason: undefined },
    {
      kind: "invalid",
      raw: '{"demo":{"source":"bogus"}}\n',
      reason: "Invalid plugin install records in handoff file",
    },
    {
      kind: "malformed",
      raw: "{invalid json",
      reason: "Malformed JSON in plugin install records file",
    },
  ])("distinguishes $kind handoffs from valid install records", async ({ kind, raw, reason }) => {
    const dir = withTempDir();
    if (!raw) {
      await expect(
        readPostCorePluginInstallRecordsFile(
          kind === "omitted" ? undefined : path.join(dir, "plugin-install-records.json"),
        ),
      ).resolves.toBeUndefined();
      return;
    }
    const filePath = path.join(dir, "plugin-install-records.json");
    await fs.writeFile(filePath, raw, "utf-8");

    await expect(readPostCorePluginInstallRecordsFile(filePath)).rejects.toThrow(
      `${reason}: ${filePath}. Run openclaw doctor to inspect and repair plugin installation state.`,
    );
  });

  it("round-trips install records through the handoff file", async () => {
    const filePath = path.join(withTempDir(), "plugin-install-records.json");
    const records = createPluginInstallRecordMap<PluginInstallRecord>();
    setPluginInstallRecordMapEntry(records, "__proto__", {
      source: "npm",
      spec: "@openclaw/demo@1.0.0",
      futureMetadata: { retained: true },
    } as PluginInstallRecord);
    await writePostCorePluginInstallRecordsFile(filePath, records);
    expect((await fs.readFile(filePath, "utf8")).endsWith("\n")).toBe(true);
    const loaded = await readPostCorePluginInstallRecordsFile(filePath);
    expect(loaded).toEqual(records);
    if (!loaded) {
      throw new Error("Missing handoff records");
    }
    expect(Object.getPrototypeOf(loaded)).toBeNull();
  });
});

describe("preparePostCorePluginInstallRecordsForFreshProcess", () => {
  it("preserves passthrough fields and untouched record identity across a downgrade handoff", () => {
    const records = createPluginInstallRecordMap<PluginInstallRecord>();
    const untouched = { source: "path" as const, sourcePath: "/tmp/local" };
    setPluginInstallRecordMapEntry(records, "newer", {
      source: "npm",
      resolvedVersion: "9999.0.0",
      resolvedSpec: "newer@9999.0.0",
      futureMetadata: { retained: true },
    } as PluginInstallRecord);
    setPluginInstallRecordMapEntry(records, "__proto__", untouched);

    const prepared = preparePostCorePluginInstallRecordsForFreshProcess({
      records,
      targetVersion: "1.0.0",
    });

    expect(prepared).not.toBe(records);
    expect(Object.getPrototypeOf(prepared)).toBeNull();
    expect(getPluginInstallRecordMapEntry(prepared, "__proto__")).toBe(untouched);
    expect(getPluginInstallRecordMapEntry(prepared, "newer")).toEqual({
      source: "npm",
      futureMetadata: { retained: true },
    });
  });
});

describe("shouldResumePostCoreUpdateInFreshProcess", () => {
  const unchangedGitResult = {
    status: "ok" as const,
    mode: "git" as const,
    root: "/tmp/openclaw",
    before: { sha: "abc123", version: "1.2.3" },
    after: { sha: "abc123", version: "1.2.3" },
    steps: [],
    durationMs: 1,
  };

  it.each([
    ["ok", true, false, "1.2.3", true],
    ["error", true, false, "1.2.3", false],
    ["ok", undefined, true, "2026.4.29-beta.1", false],
    ["ok", undefined, true, "2026.4.29", true],
    ["ok", undefined, true, "unknown", false],
  ] as const)(
    "selects the fresh writer for status=%s, install change=%s, downgrade=%s, version=%s",
    (status, installKindChanged, downgradeRisk, version, fresh) => {
      expect(
        shouldResumePostCoreUpdateInFreshProcess({
          result: {
            ...unchangedGitResult,
            status,
            ...(downgradeRisk
              ? { mode: "npm", before: { version: "2026.9.3-beta.1" }, after: { version } }
              : {}),
          },
          downgradeRisk,
          installKindChanged,
        }),
      ).toBe(fresh);
    },
  );
});

describe("post-core operator deadline provenance", () => {
  const timeout = (operator: string | null) => ({ version: 1, serialized: "2700", operator });
  const parent = (value?: unknown) => ({ completionOwner: "parent", timeout: value });
  it.each<[string, unknown, string | undefined, boolean]>([
    ["omitted operator deadline", parent(timeout(null)), undefined, true],
    ["explicit operator deadline", parent(timeout("2700")), "2700", true],
    ["legacy metadata", parent(), "2700", true],
    ["malformed metadata", parent("default"), "2700", true],
    ["missing handoff", undefined, "2700", false],
    ["child-owned completion", { completionOwner: "child", timeout: timeout(null) }, "2700", false],
    ["malformed handoff", "{", undefined, false],
  ])("preserves intent for %s", async (_name, handoff, expected, parentOwnsCompletion) => {
    const root = withTempDir();
    const resultPath = path.join(root, "plugins.json");
    if (handoff !== undefined) {
      await fs.writeFile(
        path.join(root, "handoff.json"),
        typeof handoff === "string" ? handoff : JSON.stringify(handoff),
      );
    }
    const opts = { json: true, timeout: "2700" };
    const result = resolvePostCoreUpdateHandoff({ opts, resultPath });
    if (typeof handoff === "string") {
      await expect(result).rejects.toThrow();
    } else {
      expect(await result).toEqual({
        opts: { ...opts, timeout: expected },
        parentOwnsCompletion,
      });
    }
  });
});
