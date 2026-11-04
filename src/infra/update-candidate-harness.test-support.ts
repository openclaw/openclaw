import fs from "node:fs/promises";
import path from "node:path";
import { vi, type Mock } from "vitest";
import {
  completeCanaryCommand,
  createCanarySnapshotResult,
  FakeChild,
} from "./update-candidate-canary.test-support.js";

type CommandFixture = ReturnType<Parameters<typeof completeCanaryCommand>[2]>;
type SpawnOptions = { env: NodeJS.ProcessEnv };

export function createCanaryHarness(
  mocks: { spawn: Mock; snapshot: Mock; signal: Mock },
  fixture: {
    readFixture?: () => Partial<CommandFixture>;
    databasePath?: () => string | undefined;
    isGateway?: (args: string[]) => boolean;
    onSpawn?: (args: string[], options: SpawnOptions) => void;
  } = {},
) {
  let root: string;
  let nextPid = 41_000;
  const children = new Map<number, FakeChild>();
  const child = (tracked = false) => {
    const created = new FakeChild(nextPid++);
    if (tracked) {
      children.set(created.pid, created);
    }
    return created;
  };
  return {
    child,
    children,
    snapshotDirectory: () =>
      (JSON.parse(mocks.snapshot.mock.calls.at(-1)![1].input) as { targetStateDir: string })
        .targetStateDir,
    overrideSpawn(flag: string, launch: (args: string[], options: SpawnOptions) => FakeChild) {
      const original = mocks.spawn.getMockImplementation()!;
      mocks.spawn.mockImplementation((command, args: string[], options: SpawnOptions) =>
        args.includes(flag) ? launch(args, options) : original(command, args, options),
      );
    },
    options: (timeoutMs?: number) => ({ root, stateDir: root, config: {}, env: {}, timeoutMs }),
    async reset(directory: string) {
      vi.clearAllMocks();
      root = path.join(await fs.realpath(directory), "candidate");
      await fs.mkdir(path.join(root, "dist", "infra"), { recursive: true });
      for (const file of ["index.js", "infra/update-migrated-finalize.worker.js"]) {
        await fs.writeFile(path.join(root, "dist", file), "");
      }
      await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "2026.9.1" }));
      mocks.snapshot.mockImplementation(async (_command, options: { input: string }) =>
        createCanarySnapshotResult(options.input, fixture.databasePath?.()),
      );
      mocks.spawn.mockImplementation((_command, args: string[], options: SpawnOptions) => {
        const created = child(true);
        fixture.onSpawn?.(args, options);
        if (!(fixture.isGateway?.(args) ?? args.includes("gateway"))) {
          completeCanaryCommand(created, args, () => ({
            pluginInventory: undefined,
            pluginErrors: false,
            runtimeContract: { state: 2, agent: 3 },
            runtimeError: false,
            lintReport: { ok: true, checksRun: 1, findings: [], warnings: [] },
            ...fixture.readFixture?.(),
          }));
        }
        return created;
      });
      mocks.signal.mockImplementation(
        (pid: number, _signal: string, options: { onComplete?: () => void }) => {
          children.get(pid)?.emit("close", 0);
          options.onComplete?.();
        },
      );
      return root;
    },
    dispose() {
      vi.unstubAllGlobals();
      for (const created of children.values()) {
        created.stdout.destroy();
        created.stderr.destroy();
      }
      children.clear();
    },
  };
}
