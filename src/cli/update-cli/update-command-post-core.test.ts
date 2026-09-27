// Post-core install-records handoff reader: missing vs malformed JSON.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireDistArtifactOwnership } from "../../../scripts/lib/dist-artifact-lock.mts";
import {
  createPluginInstallRecordMap,
  getPluginInstallRecordMapEntry,
  setPluginInstallRecordMapEntry,
} from "../../config/plugin-install-record-map.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { isPidAlive } from "../../shared/pid-alive.js";
import { killPidIfAlive, readPidFile, waitForPidToExit } from "../../test-utils/process-tree.js";
import type { PostCorePluginUpdateResult } from "./update-command-plugins.js";
import {
  continuePostCoreUpdateInFreshProcess,
  preparePostCorePluginInstallRecordsForFreshProcess,
  postCoreUpdateParentOwnsCompletion,
  resolvePostCoreUpdateOperatorOptions,
  readPostCorePluginInstallRecordsFile,
  shouldResumePostCoreUpdateInFreshProcess,
  writePostCorePluginInstallRecordsFile,
  writePostCorePluginUpdateResultFile,
  writePostCoreUpdateFailureFile,
} from "./update-command-post-core.js";

const tempDirs: string[] = [];
const pluginUpdate: PostCorePluginUpdateResult = {
  status: "ok",
  changed: true,
  sync: {
    changed: false,
    switchedToBundled: [],
    switchedToNpm: [],
    warnings: [],
    errors: [],
  },
  npm: { changed: false, outcomes: [] },
  integrityDrifts: [],
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
});

async function withTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-post-core-records-"));
  tempDirs.push(dir);
  return dir;
}

describe("continuePostCoreUpdateInFreshProcess", () => {
  it.each([false, true])(
    "releases artifact ownership only for a target without the prepared-fact consumer (modern=%s)",
    async (modern) => {
      const root = await withTempDir();
      const observation = path.join(root, "ownership.txt");
      await fs.mkdir(path.join(root, "dist"));
      await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "9999.0.0" }));
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
await fs.writeFile(${JSON.stringify(observation)}, observed);
await fs.writeFile(process.env.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH, ${JSON.stringify(JSON.stringify(pluginUpdate))});
`,
      );
      const sourceArtifactLock = await acquireDistArtifactOwnership(root);
      try {
        const result = await continuePostCoreUpdateInFreshProcess({
          root,
          sourceRuntimePrepared: true,
          channel: "dev",
          requestedChannel: null,
          opts: {
            json: true,
            run: { runId: "fixture-source-lock", env: {}, sourceArtifactLock },
          },
          pluginInstallRecords: {},
          updateStartedAtMs: Date.now(),
          timeoutMs: 5000,
          nodeRunner: process.execPath,
        });
        expect(result).toEqual({ resumed: true, pluginUpdate });
        expect(await fs.readFile(observation, "utf8")).toBe(
          modern ? "parent-held" : "child-acquired",
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
      const root = await withTempDir();
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
          requestedChannel: null,
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
      });
      await expect(fs.stat(handoff.resultDir)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});

describe("post-core result publication", () => {
  it.runIf(process.platform !== "win32").each(["success", "failure"] as const)(
    "keeps the handoff private after publishing %s",
    async (outcome) => {
      const dir = await withTempDir();
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
  it("returns undefined when the path is omitted", async () => {
    await expect(readPostCorePluginInstallRecordsFile(undefined)).resolves.toBeUndefined();
  });

  it("returns undefined when the handoff file is missing", async () => {
    const dir = await withTempDir();
    const missing = path.join(dir, "missing-plugin-install-records.json");
    await expect(readPostCorePluginInstallRecordsFile(missing)).resolves.toBeUndefined();
  });

  it("loads a prototype-safe install-records handoff with legal special ids", async () => {
    const dir = await withTempDir();
    const filePath = path.join(dir, "plugin-install-records.json");
    await fs.writeFile(
      filePath,
      '{"demo":{"source":"npm","spec":"@openclaw/demo@1.0.0","installPath":"/tmp/demo-plugin","futureMetadata":{"retained":true}},"constructor":{"source":"path"},"toString":{"source":"git"},"__proto__":{"source":"archive"}}\n',
      "utf-8",
    );

    const records = await readPostCorePluginInstallRecordsFile(filePath);
    if (!records) {
      throw new Error("Expected plugin install records handoff");
    }
    expect(Object.getPrototypeOf(records)).toBeNull();
    expect(getPluginInstallRecordMapEntry(records, "demo")).toEqual({
      source: "npm",
      spec: "@openclaw/demo@1.0.0",
      installPath: "/tmp/demo-plugin",
      futureMetadata: { retained: true },
    });
    expect(getPluginInstallRecordMapEntry(records, "constructor")).toEqual({ source: "path" });
    expect(getPluginInstallRecordMapEntry(records, "toString")).toEqual({ source: "git" });
    expect(getPluginInstallRecordMapEntry(records, "__proto__")).toEqual({ source: "archive" });
  });

  it("fails closed on structurally invalid handoff records", async () => {
    const dir = await withTempDir();
    const filePath = path.join(dir, "plugin-install-records.json");
    await fs.writeFile(filePath, '{"demo":{"source":"bogus"}}\n', "utf-8");

    await expect(readPostCorePluginInstallRecordsFile(filePath)).rejects.toThrow(
      `Invalid plugin install records in handoff file: ${filePath}`,
    );
  });

  it("writes UTF-8 byte order and preserves special ids and passthrough fields", async () => {
    const dir = await withTempDir();
    const filePath = path.join(dir, "plugin-install-records.json");
    const records = createPluginInstallRecordMap<PluginInstallRecord>();
    setPluginInstallRecordMapEntry(records, "\u{10000}", { source: "git" });
    setPluginInstallRecordMapEntry(records, "__proto__", { source: "archive" });
    setPluginInstallRecordMapEntry(records, "2", {
      source: "npm",
      futureMetadata: { retained: true },
    } as PluginInstallRecord);
    setPluginInstallRecordMapEntry(records, "toString", { source: "git" });
    setPluginInstallRecordMapEntry(records, "\uE000", { source: "path" });
    setPluginInstallRecordMapEntry(records, "constructor", { source: "path" });
    setPluginInstallRecordMapEntry(records, "10", { source: "path" });
    setPluginInstallRecordMapEntry(records, "1", { source: "archive" });
    await writePostCorePluginInstallRecordsFile(filePath, records);

    expect(await fs.readFile(filePath, "utf-8")).toBe(
      '{"1":{"source":"archive"},"10":{"source":"path"},"2":{"source":"npm","futureMetadata":{"retained":true}},"__proto__":{"source":"archive"},"constructor":{"source":"path"},"toString":{"source":"git"},"\uE000":{"source":"path"},"\u{10000}":{"source":"git"}}\n',
    );
    const loaded = await readPostCorePluginInstallRecordsFile(filePath);
    if (!loaded) {
      throw new Error("Expected plugin install records handoff");
    }
    expect(Object.getPrototypeOf(loaded)).toBeNull();
    expect(getPluginInstallRecordMapEntry(loaded, "2")).toEqual({
      source: "npm",
      futureMetadata: { retained: true },
    });
    expect(getPluginInstallRecordMapEntry(loaded, "__proto__")).toEqual({ source: "archive" });
  });

  it("fails closed on malformed handoff JSON with a path-labelled error", async () => {
    const dir = await withTempDir();
    const filePath = path.join(dir, "plugin-install-records.json");
    await fs.writeFile(filePath, "{invalid json", "utf-8");

    await expect(readPostCorePluginInstallRecordsFile(filePath)).rejects.toThrow(
      `Malformed JSON in plugin install records file: ${filePath}`,
    );
    await expect(readPostCorePluginInstallRecordsFile(filePath)).rejects.toThrow(
      "Run openclaw doctor to inspect and repair plugin installation state.",
    );
  });
});

describe("preparePostCorePluginInstallRecordsForFreshProcess", () => {
  it("preserves passthrough fields and untouched record identity across a downgrade handoff", () => {
    const records = createPluginInstallRecordMap<PluginInstallRecord>();
    const untouched = { source: "path" as const, sourcePath: "/tmp/local" };
    const constructorRecord = { source: "git" as const };
    const toStringRecord = { source: "archive" as const };
    const protoRecord = { source: "path" as const, sourcePath: "/tmp/proto" };
    setPluginInstallRecordMapEntry(records, "newer", {
      source: "npm",
      resolvedVersion: "9999.0.0",
      resolvedSpec: "newer@9999.0.0",
      futureMetadata: { retained: true },
    } as PluginInstallRecord);
    setPluginInstallRecordMapEntry(records, "untouched", untouched);
    setPluginInstallRecordMapEntry(records, "constructor", constructorRecord);
    setPluginInstallRecordMapEntry(records, "toString", toStringRecord);
    setPluginInstallRecordMapEntry(records, "__proto__", protoRecord);

    const prepared = preparePostCorePluginInstallRecordsForFreshProcess({
      records,
      targetVersion: "1.0.0",
    });

    expect(prepared).not.toBe(records);
    expect(Object.getPrototypeOf(prepared)).toBeNull();
    expect(getPluginInstallRecordMapEntry(prepared, "untouched")).toBe(untouched);
    expect(getPluginInstallRecordMapEntry(prepared, "constructor")).toBe(constructorRecord);
    expect(getPluginInstallRecordMapEntry(prepared, "toString")).toBe(toStringRecord);
    expect(getPluginInstallRecordMapEntry(prepared, "__proto__")).toBe(protoRecord);
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

  it("uses the fresh CLI after an install-kind switch with unchanged git metadata", () => {
    expect(
      shouldResumePostCoreUpdateInFreshProcess({
        result: unchangedGitResult,
        downgradeRisk: false,
        installKindChanged: true,
      }),
    ).toBe(true);
  });

  it("does not resume a skipped git update with unchanged metadata", () => {
    expect(
      shouldResumePostCoreUpdateInFreshProcess({
        result: { ...unchangedGitResult, status: "skipped" },
        downgradeRisk: false,
        installKindChanged: false,
      }),
    ).toBe(false);
  });

  it("does not resume after a failed install-kind switch", () => {
    expect(
      shouldResumePostCoreUpdateInFreshProcess({
        result: { ...unchangedGitResult, status: "error" },
        downgradeRisk: false,
        installKindChanged: true,
      }),
    ).toBe(false);
  });

  it.each([
    { version: "2026.4.28", fresh: false },
    { version: "2026.4.29-beta.1", fresh: false },
    { version: "2026.4.29", fresh: true },
    { version: "2026.9.1", fresh: true },
    { version: "unknown", fresh: false },
    { version: undefined, fresh: false },
  ])("selects the downgrade config writer for $version", ({ version, fresh }) => {
    expect(
      shouldResumePostCoreUpdateInFreshProcess({
        result: {
          ...unchangedGitResult,
          mode: "npm",
          before: { version: "2026.9.3-beta.1" },
          after: { version },
        },
        downgradeRisk: true,
      }),
    ).toBe(fresh);
  });
});

describe("post-core operator deadline provenance", () => {
  it.each([
    {
      name: "omitted operator deadline",
      value: { version: 1, serialized: "2700", operator: null },
      expected: undefined,
    },
    {
      name: "explicit operator deadline",
      value: { version: 1, serialized: "2700", operator: "2700" },
      expected: "2700",
    },
    { name: "legacy metadata", value: undefined, expected: "2700" },
    {
      name: "missing operator provenance",
      value: { version: 1, serialized: "2700" },
      expected: "2700",
    },
    {
      name: "mismatched command",
      value: { version: 1, serialized: "1800", operator: null },
      expected: "2700",
    },
    {
      name: "unknown version",
      value: { version: 2, serialized: "2700", operator: null },
      expected: "2700",
    },
    {
      name: "malformed operator",
      value: { version: 1, serialized: "2700", operator: false },
      expected: "2700",
    },
    { name: "malformed metadata", value: "default", expected: "2700" },
  ])("preserves intent for $name", async ({ value, expected }) => {
    const root = await withTempDir();
    const resultPath = path.join(root, "plugins.json");
    await fs.writeFile(
      path.join(root, "handoff.json"),
      JSON.stringify({ completionOwner: "parent", timeout: value }),
    );
    const opts = { json: true, timeout: "2700" };
    expect(await resolvePostCoreUpdateOperatorOptions({ opts, resultPath })).toEqual({
      ...opts,
      timeout: expected,
    });
    // The shipped completion reader ignores added metadata and keeps its ownership contract.
    expect(await postCoreUpdateParentOwnsCompletion(resultPath)).toBe(true);
  });

  it("retains an explicit deadline without private parent ownership", async () => {
    const root = await withTempDir();
    const resultPath = path.join(root, "plugins.json");
    const opts = { timeout: "3" };
    expect(await resolvePostCoreUpdateOperatorOptions({ opts, resultPath })).toBe(opts);
    await fs.writeFile(
      path.join(root, "handoff.json"),
      JSON.stringify({
        completionOwner: "child",
        timeout: { version: 1, serialized: "3", operator: null },
      }),
    );
    expect(await resolvePostCoreUpdateOperatorOptions({ opts, resultPath })).toBe(opts);
    await fs.writeFile(path.join(root, "handoff.json"), "{");
    await expect(resolvePostCoreUpdateOperatorOptions({ opts, resultPath })).rejects.toThrow();
  });
});
