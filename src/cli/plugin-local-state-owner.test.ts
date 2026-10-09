import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerMatrixCliMetadata } from "../../extensions/matrix/cli-metadata.js";
import { registerMemoryCli } from "../../extensions/memory-core/cli.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetConfigRuntimeState } from "../config/config.js";
import {
  acquireGatewayLock,
  readLockPayloadSync,
  resolveGatewayLockPaths,
  type GatewayLockHandle,
} from "../infra/gateway-lock.js";
import { createTestPluginApi } from "../plugin-sdk/plugin-test-api.js";
import type { OpenClawPluginCliRegistrar } from "../plugins/plugin-registration.types.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";

const fixture = vi.hoisted(() => ({
  external: false,
  memory: vi.fn(async () => {}),
  matrix: vi.fn(async (): Promise<unknown[]> => []),
  config: vi.fn(() => ({
    channels: {
      matrix: { homeserver: "https://matrix.example.org", userId: "@fixture:example.org" },
    },
  })),
}));

vi.mock("../infra/gateway-state-owner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/gateway-state-owner.js")>();
  return {
    ...actual,
    // Model the external CLI's absent process-local owner; retain real lock discovery.
    captureGatewayStateOwner: (...args: Parameters<typeof actual.captureGatewayStateOwner>) =>
      fixture.external ? undefined : actual.captureGatewayStateOwner(...args),
  };
});

// mock-isolation: Domain behavior has plugin-owned coverage; this fixture observes admission.
vi.mock("../../extensions/memory-core/src/cli.runtime.js", () => ({
  runMemoryStatus: fixture.memory,
  runMemoryIndex: fixture.memory,
  runMemorySearch: fixture.memory,
  runMemoryForget: fixture.memory,
  runMemoryReset: fixture.memory,
  runMemoryPromote: fixture.memory,
  runMemoryPromoteExplain: fixture.memory,
  runMemoryRemHarness: fixture.memory,
  runMemoryRemBackfill: fixture.memory,
  runMemorySessionBackfill: fixture.memory,
}));

vi.mock("../../extensions/matrix/src/matrix/actions/verification.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../extensions/matrix/src/matrix/actions/verification.js")
  >()),
  listMatrixVerifications: fixture.matrix,
  getMatrixVerificationSas: fixture.matrix,
}));

// mock-isolation: Do not create a Matrix SDK/network runtime to test CLI owner admission.
vi.mock("../../extensions/matrix/src/runtime.js", () => ({
  getMatrixRuntime: () => ({ config: { current: fixture.config } }),
}));

const roots = useAutoCleanupTempDirTracker(afterAll);
let root: string;
let owner: GatewayLockHandle | null = null;
let matrixRegistrar: OpenClawPluginCliRegistrar;

beforeAll(() => {
  root = roots.make("openclaw-plugin-cli-owner-");
  fs.writeFileSync(path.join(root, "openclaw.json"), "{}\n");
  registerMatrixCliMetadata(
    createTestPluginApi({
      registerCli(registrar) {
        matrixRegistrar = registrar;
      },
    }),
  );
});

beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
  resetConfigRuntimeState();
  fixture.external = false;
  fixture.memory.mockClear();
  fixture.matrix.mockClear();
  fixture.config.mockClear();
  process.exitCode = 0;
});

afterEach(async () => {
  await owner?.release();
  owner = null;
  await closeOpenClawStateDatabaseAsync();
  resetConfigRuntimeState();
  fixture.external = false;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = 0;
});

async function runCli(args: string[]) {
  const program = new Command();
  if (args[0] === "memory") {
    registerMemoryCli(program);
  } else {
    await matrixRegistrar({
      program,
      parentPath: [],
      config: {},
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
  }
  await program.parseAsync(args, { from: "user" });
}

async function occupyState() {
  owner = await acquireGatewayLock({
    env: process.env,
    port: 18789,
    allowInTests: true,
    timeoutMs: 0,
  });
  expect(owner).not.toBeNull();
  fixture.external = true;
}

describe("plugin commands respect the local state owner", () => {
  it.each([
    ["status"],
    ["index"],
    ["search", "query"],
    ["forget", "--session", "fixture"],
    ["reset", "--yes"],
    ["promote", "--apply"],
    ["promote-explain", "fixture"],
    ["rem-harness"],
    ["rem-backfill", "--stage-short-term"],
    ["session-backfill", "--apply"],
  ])("refuses memory %s before opening its runtime", async (...args) => {
    await occupyState();
    await expect(runCli(["memory", ...args])).rejects.toThrow("exclusive offline state ownership");
    expect(fixture.memory).not.toHaveBeenCalled();
  });

  it.each([["list"], ["sas", "fixture"]])(
    "refuses Matrix verify %s before account config or crypto access",
    async (...args) => {
      await occupyState();
      const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await runCli(["matrix", "verify", ...args, "--json"]);
      expect(process.exitCode).toBe(1);
      expect(output).toHaveBeenCalledWith(
        expect.stringContaining("exclusive offline state ownership"),
      );
      expect(fixture.config).not.toHaveBeenCalled();
      expect(fixture.matrix).not.toHaveBeenCalled();
    },
  );

  it.each(["memory", "matrix"] as const)(
    "retains offline %s ownership until the command settles",
    async (family) => {
      const entered = createDeferred<void>();
      const finish = createDeferred<void>();
      const ownerPath = resolveGatewayLockPaths(process.env).ownerLockPath;
      const action = async () => {
        entered.resolve();
        await finish.promise;
        expect(readLockPayloadSync(ownerPath, true)).toMatchObject({
          pid: process.pid,
          role: "agent-embedded",
        });
        return [];
      };
      if (family === "memory") {
        fixture.memory.mockImplementationOnce(async () => {
          await action();
        });
      } else {
        fixture.matrix.mockImplementationOnce(action);
      }
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const operation = runCli(
        family === "memory" ? ["memory", "index"] : ["matrix", "verify", "list", "--json"],
      );
      try {
        await awaitGateBeforeSettlement(entered.promise, operation, "command did not enter");
        expect(readLockPayloadSync(ownerPath, true)).toMatchObject({ role: "agent-embedded" });
      } finally {
        finish.resolve();
        await operation;
      }
      expect(process.exitCode).toBe(0);
      expect(fs.existsSync(ownerPath)).toBe(false);
    },
  );
});
