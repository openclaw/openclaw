import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as canaryProcess from "./update-candidate-canary-process.js";
import { validateUpdateCandidateCanary } from "./update-candidate-canary.js";
import {
  completeCanaryCommand,
  createCanarySnapshotResult,
  FakeChild,
} from "./update-candidate-canary.test-support.js";
import { prepareUpdateCandidateRehearsal } from "./update-candidate-rehearsal.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), snapshot: vi.fn(), signal: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) =>
  (await import("./update-candidate-canary-mocks.test-support.js")).mockCanaryChildProcesses(
    await importOriginal<typeof import("node:child_process")>(),
    mocks.spawn,
  ),
);
vi.mock("../process/exec.js", async (importOriginal) =>
  (await import("./update-candidate-canary-mocks.test-support.js")).mockCanarySnapshotCommands(
    await importOriginal<typeof import("../process/exec.js")>(),
    mocks.snapshot,
  ),
);
vi.mock("../process/kill-tree.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/kill-tree.js")>()),
  signalProcessTree: mocks.signal,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const children = new Map<number, FakeChild>();
const copiedStateDirs = new Set<string>();
let root: string;
let nextPid = 41_000;
let doctorExitCode = 0;

function canaryOptions() {
  return { root, stateDir: root, config: {}, env: {}, timeoutMs: 3_000 };
}

beforeEach(async () => {
  vi.clearAllMocks();
  doctorExitCode = 0;
  root = path.join(await fs.realpath(tempDirs.make("canary-retention-")), "candidate");
  await fs.mkdir(path.join(root, "dist", "infra"), { recursive: true });
  await fs.writeFile(path.join(root, "dist", "index.js"), "");
  await fs.writeFile(path.join(root, "dist", "infra", "update-migrated-finalize.worker.js"), "");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "2026.9.1" }));
  mocks.snapshot.mockImplementation(async (_command, options: { input: string }) =>
    createCanarySnapshotResult(options.input),
  );
  mocks.spawn.mockImplementation(
    (_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      const child = new FakeChild(nextPid++);
      children.set(child.pid, child);
      const configPath = options.env.OPENCLAW_CONFIG_PATH;
      const stateDir = options.env.OPENCLAW_STATE_DIR;
      if (!configPath || !stateDir) {
        throw new Error("Missing rehearsal paths");
      }
      copiedStateDirs.add(stateDir);
      if (args.includes("--fix")) {
        void fs
          .readFile(configPath, "utf8")
          .then(async (raw) => {
            const config: unknown = JSON.parse(raw);
            if (!isRecord(config)) {
              throw new Error("Invalid rehearsal fixture");
            }
            config.meta = { migrations: { utilityModelSeparation: true } };
            await fs.writeFile(configPath, JSON.stringify(config));
            child.emit("close", doctorExitCode);
          })
          .catch((error: unknown) => child.emit("error", error));
      } else {
        completeCanaryCommand(child, args, () => ({
          pluginInventory: undefined,
          pluginErrors: false,
          runtimeContract: { state: 2, agent: 3 },
          runtimeError: false,
          lintReport: {
            ok: false,
            checksRun: 1,
            findings: [{ checkId: "core/config", severity: "error", message: "Repair needed." }],
            warnings: [],
          },
        }));
      }
      return child;
    },
  );
  mocks.signal.mockImplementation(
    (pid: number, _signal: string, options: { onComplete?: () => void }) => {
      children.get(pid)?.emit("close", 0);
      options.onComplete?.();
    },
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.values()) {
    child.stdout.destroy();
    child.stderr.destroy();
  }
  children.clear();
  for (const stateDir of copiedStateDirs) {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
  copiedStateDirs.clear();
});

describe("failed canary rehearsal ownership", () => {
  it.each([undefined, true])(
    "retains the migrated copy only when its caller takes cleanup ownership (%s)",
    async (retainFailedRehearsal) => {
      const result = await validateUpdateCandidateCanary({
        ...canaryOptions(),
        sourceConfigHash: "original-config-hash",
        retainFailedRehearsal,
      });
      expect(result).toMatchObject({ status: "error", phase: "lint" });
      expect(result.doctorConfigChanges).toEqual([{ kind: "key", key: "meta" }]);
      const stateDir = [...copiedStateDirs][0];
      expect(stateDir).toBeDefined();
      if (retainFailedRehearsal) {
        const retained = result.retainedRehearsal;
        expect(retained).toBeDefined();
        expect(retained?.rehearsal).toMatchObject({
          stateDir,
          sourceConfigHash: "original-config-hash",
          sourceConfig: {},
        });
        const raw = await fs.readFile(retained!.rehearsal.configPath, "utf8");
        expect(JSON.parse(raw)).toMatchObject({
          meta: { migrations: { utilityModelSeparation: true } },
        });
        await retained!.cleanup();
      } else {
        expect(result.retainedRehearsal).toBeUndefined();
      }
      await expect(fs.access(stateDir!)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("cannot transfer a copy after any child has unconfirmed teardown", async () => {
    vi.spyOn(canaryProcess, "terminateCanary").mockResolvedValueOnce(false);
    const result = await validateUpdateCandidateCanary({
      ...canaryOptions(),
      retainFailedRehearsal: true,
    });
    expect(result).toMatchObject({ status: "error", phase: "lint" });
    expect(result.retainedRehearsal).toBeUndefined();
    expect(result.steps).toContainEqual(
      expect.objectContaining({
        name: "candidate-doctor-cleanup",
        advisory: expect.objectContaining({ kind: "recoverable-maintenance" }),
      }),
    );
    await expect(fs.access([...copiedStateDirs][0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not retain an incomplete snapshot", async () => {
    mocks.snapshot.mockRejectedValueOnce(new Error("Snapshot unavailable"));
    const result = await validateUpdateCandidateCanary({
      ...canaryOptions(),
      retainFailedRehearsal: true,
    });
    expect(result).toMatchObject({ status: "error", phase: "snapshot" });
    expect(result.retainedRehearsal).toBeUndefined();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("does not retain partially migrated state after Doctor fails", async () => {
    doctorExitCode = 1;
    const result = await validateUpdateCandidateCanary({
      ...canaryOptions(),
      retainFailedRehearsal: true,
    });
    expect(result).toMatchObject({ status: "error", phase: "doctor" });
    expect(result.doctorConfigChanges).toEqual([{ kind: "key", key: "meta" }]);
    expect(result.retainedRehearsal).toBeUndefined();
    await expect(fs.access([...copiedStateDirs][0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records a warning when the new owner's cleanup cannot remove the retained copy", async () => {
    const onStep = vi.fn();
    const result = await validateUpdateCandidateCanary({
      ...canaryOptions(),
      retainFailedRehearsal: true,
      onStep,
    });
    const retained = result.retainedRehearsal;
    expect(retained).toBeDefined();
    const remove = fs.rm.bind(fs);
    const denial = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (target === retained!.rehearsal.stateDir) {
        throw new Error("Synthetic cleanup permission denied");
      }
      return remove(target, options);
    });
    try {
      await expect(retained!.cleanup()).resolves.toBeUndefined();
      expect(result).toMatchObject({ status: "error", phase: "lint" });
      const warning = result.steps.at(-1);
      expect(warning).toMatchObject({
        name: "candidate-state-cleanup",
        advisory: {
          kind: "recoverable-maintenance",
          message: expect.stringContaining("Synthetic cleanup permission denied"),
        },
      });
      expect(onStep).toHaveBeenLastCalledWith(warning);
      await expect(fs.access(retained!.rehearsal.configPath)).resolves.toBeUndefined();
    } finally {
      denial.mockRestore();
      await retained!.cleanup();
    }
  });

  it("leaves an already caller-owned rehearsal with its original owner", async () => {
    const rehearsal = await prepareUpdateCandidateRehearsal({
      ...canaryOptions(),
      candidateRoot: root,
    });
    try {
      const result = await validateUpdateCandidateCanary({
        ...canaryOptions(),
        rehearsal,
        retainFailedRehearsal: true,
      });
      expect(result).toMatchObject({ status: "error", phase: "lint" });
      expect(result.retainedRehearsal).toBeUndefined();
      await expect(fs.access(rehearsal.configPath)).resolves.toBeUndefined();
    } finally {
      await rehearsal.cleanup();
    }
  });
});
