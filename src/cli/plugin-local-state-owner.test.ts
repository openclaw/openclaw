import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import { GATEWAY_SERVER_CAPS } from "../../packages/gateway-protocol/src/server-capabilities.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetConfigRuntimeState } from "../config/config.js";
import type { CallGatewayOptions } from "../gateway/call.js";
import { memorySearchHandlers } from "../gateway/server-methods/memory-search.js";
import type {
  GatewayRequestHandler,
  GatewayRequestHandlerOptions,
} from "../gateway/server-methods/types.js";
import {
  acquireGatewayLock,
  readLockPayloadSync,
  resolveGatewayLockPaths,
  type GatewayLockHandle,
} from "../infra/gateway-lock.js";
import type { MemorySearchManager } from "../memory-host-sdk/host/types.js";
import { createTestPluginApi } from "../plugin-sdk/plugin-test-api.js";
import { createPluginRuntimeMock } from "../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import type { OpenClawPluginApi } from "../plugins/plugin-api.types.js";
import type { OpenClawPluginCliRegistrar } from "../plugins/plugin-registration.types.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";

const fixture = vi.hoisted(() => ({
  external: false,
  callGateway: vi.fn<(options: CallGatewayOptions) => Promise<unknown>>(),
  executeBatch: vi.fn<() => Promise<ReturnType<typeof backfillExecution>>>(),
  memoryManager: vi.fn(),
  search: vi.fn<MemorySearchManager["search"]>(),
  searchClose: vi.fn(async () => {}),
  status: vi.fn(),
  bootstrap: vi.fn(),
  recovery: vi.fn(),
  memory: vi.fn(async () => {}),
  matrix: vi.fn(async (): Promise<unknown[]> => []),
  config: vi.fn(() => ({
    channels: {
      matrix: { homeserver: "https://matrix.example.org", userId: "@fixture:example.org" },
    },
  })),
}));

vi.mock("../plugins/memory-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/memory-runtime.js")>()),
  getActiveMemorySearchManagerCore: fixture.memoryManager,
  // The injected Memory Core manager uses the legacy manager contract.
  isActiveMemoryProviderNative: () => false,
}));

vi.mock("../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/call.js")>()),
  callGateway: fixture.callGateway,
}));

// mock-isolation: Exercise the real Gateway adapter without transcript/model execution.
vi.mock("../../extensions/memory-core/src/session-backfill-gateway.runtime.js", () => ({
  executeSessionBackfillBatch: fixture.executeBatch,
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
  ...(await importOriginal<Record<string, unknown>>()),
  listMatrixVerifications: fixture.matrix,
  getMatrixVerificationSas: fixture.matrix,
  getMatrixVerificationStatus: fixture.status,
  bootstrapMatrixVerification: fixture.bootstrap,
  verifyMatrixRecoveryKey: fixture.recovery,
}));

// mock-isolation: Do not create a Matrix SDK/network runtime to test CLI owner admission.
vi.mock("../../extensions/matrix/src/runtime.js", () => ({
  getMatrixRuntime: () => ({ config: { current: fixture.config } }),
  setMatrixRuntimeLifecycle: () => {},
}));

const { registerMatrixCliMetadata } = await loadBundledPluginFacade<{
  registerMatrixCliMetadata: (api: OpenClawPluginApi) => void;
}>({ pluginId: "matrix", artifactBasename: "cli-metadata.js" });
const { registerMatrixFullRuntime } = await loadBundledPluginFacade<{
  registerMatrixFullRuntime: (api: OpenClawPluginApi) => void;
}>({ pluginId: "matrix", artifactBasename: "index.js" });
const { registerMemoryCli } = await loadBundledPluginFacade<{
  registerMemoryCli: (program: Command) => void;
}>({ pluginId: "memory-core", artifactBasename: "cli.js" });
const { default: memoryCore } = await loadBundledPluginFacade<{
  default: { register(api: OpenClawPluginApi): void };
}>({ pluginId: "memory-core", artifactBasename: "index.js" });

const roots = useAutoCleanupTempDirTracker(afterAll);
let root: string;
let owner: GatewayLockHandle | null = null;
let ownerId: string | undefined;
let matrixRegistrar: OpenClawPluginCliRegistrar;
const methods = new Map<string, GatewayRequestHandler>();
const gatewayConfig = {
  plugins: { entries: { "memory-core": { config: { dreaming: { enabled: false } } } } },
  agents: { entries: { main: {} } },
  channels: { matrix: { accounts: { ops: { homeserver: "https://gateway.example.org" } } } },
};

async function dispatchToGateway(options: CallGatewayOptions) {
  await options.prepareDispatchCurrent?.();
  options.assertDispatchCurrent?.();
  const handler = methods.get(options.method);
  if (!handler) {
    throw new Error(`Missing fixture Gateway method: ${options.method}`);
  }
  const respond = vi.fn();
  fixture.external = false;
  try {
    await handler({
      params: options.params,
      respond,
      context: { getRuntimeConfig: () => gatewayConfig },
      hasCurrentClientAuthority: () => true,
    } as unknown as GatewayRequestHandlerOptions);
  } finally {
    fixture.external = true;
  }
  const response = respond.mock.calls[0];
  if (!response?.[0]) {
    throw new GatewayClientRequestError(
      response?.[2] ?? {
        code: "UNAVAILABLE",
        message: response?.[1]?.error ?? "Gateway refused request",
      },
    );
  }
  return response[1];
}

function backfillExecution(
  overrides: { continuation?: { advanced: boolean; hasMore: boolean } } = {},
) {
  return {
    result: {
      agentId: "main",
      workspaceDir: "/gateway/workspace",
      applied: true,
      rem: false,
      days: [
        { day: "2026-10-01", candidateCount: 4, topCandidates: ["one", "two", "three", "four"] },
      ],
      candidateCount: 4,
      stagedEntries: 3,
      writtenDiaryEntries: 1,
      replacedDiaryEntries: 2,
    },
    continuation: { advanced: true, hasMore: false },
    ...overrides,
  };
}

beforeAll(() => {
  root = roots.make("openclaw-plugin-cli-owner-");
  fs.writeFileSync(path.join(root, "openclaw.json"), "{}\n");
  const api = createTestPluginApi({
    runtime: createPluginRuntimeMock({
      config: { current: () => gatewayConfig },
      agent: { resolveAgentWorkspaceDir: () => "/gateway/workspace" },
    }),
    registerGatewayMethod: (name, handler) => {
      methods.set(name, handler);
    },
  });
  registerMatrixFullRuntime(api);
  memoryCore.register(api);
  for (const [method, handler] of Object.entries(memorySearchHandlers)) {
    methods.set(method, handler);
  }
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
  fixture.callGateway.mockReset().mockImplementation(dispatchToGateway);
  fixture.executeBatch.mockReset().mockResolvedValue(backfillExecution());
  fixture.search.mockReset().mockResolvedValue([]);
  fixture.searchClose.mockReset().mockResolvedValue(undefined);
  fixture.memoryManager.mockReset().mockResolvedValue({
    manager: {
      search: fixture.search,
      status: () => ({ backend: "builtin", provider: "none", dirty: false, workspaceDir: root }),
      close: fixture.searchClose,
    },
  });
  fixture.status.mockReset();
  fixture.bootstrap.mockReset();
  fixture.recovery.mockReset();
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
  ownerId = readLockPayloadSync(resolveGatewayLockPaths(process.env).ownerLockPath, true)?.ownerId;
  expect(ownerId).toBeTruthy();
  fixture.external = true;
}

describe("plugin commands respect the local state owner", () => {
  it.each([
    ["status"],
    ["index"],
    ["forget", "--session", "fixture"],
    ["reset", "--yes"],
    ["promote", "--apply"],
    ["promote-explain", "fixture"],
    ["rem-harness"],
    ["rem-backfill", "--stage-short-term"],
    ["session-backfill", "--apply", "--archive-files", "archive.jsonl"],
    ["session-backfill", "--rem"],
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

  it.each(["memory", "memory-backfill", "memory-search", "matrix"] as const)(
    "retains offline %s ownership until the command settles",
    async (family) => {
      const entered = createDeferred();
      const finish = createDeferred();
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
      if (family !== "matrix") {
        fixture.memory.mockImplementationOnce(async () => {
          await action();
        });
      } else {
        fixture.matrix.mockImplementationOnce(action);
      }
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const operation = runCli(
        family === "matrix"
          ? ["matrix", "verify", "list", "--json"]
          : family === "memory-search"
            ? ["memory", "search", "query", "--json"]
            : ["memory", family === "memory-backfill" ? "session-backfill" : "index"],
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

  it.each([
    ["status", [], "matrix.verify.status.owner", "status", { pendingVerifications: 0 }],
    [
      "bootstrap",
      [],
      "matrix.verify.bootstrap.owner",
      "bootstrap",
      { success: false, error: "verification incomplete" },
    ],
    ["device", ["synthetic-key"], "matrix.verify.recoveryKey.owner", "recovery", { success: true }],
  ] as const)(
    "routes Matrix verify %s to the discovered owner's existing handler",
    async (command, flags, method, mock, result) => {
      await occupyState();
      fixture[mock].mockResolvedValue(result);
      const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await runCli(["matrix", "verify", command, ...flags, "--account", "ops", "--json"]);
      expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toEqual(result);
      expect(fixture.callGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          method,
          params: expect.objectContaining({ expectedOwnerId: ownerId, accountId: "ops" }),
          requiredMethods: [method],
          requiredCapabilities: [GATEWAY_SERVER_CAPS.LOCAL_STATE_OWNER_ROUTING],
        }),
      );
      expect(fixture[mock]).toHaveBeenCalledTimes(1);
      const domainArgs = fixture[mock].mock.calls[0];
      expect(domainArgs?.at(-1)).toMatchObject({ cfg: gatewayConfig, accountId: "ops" });
      expect(fixture.config).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(mock === "bootstrap" ? 1 : 0);
    },
  );

  it.each(["preview", "apply", "rollback"] as const)(
    "routes memory backfill %s and retains its complete CLI result",
    async (operation) => {
      await occupyState();
      const first = backfillExecution();
      if (operation === "apply") {
        first.continuation.hasMore = true;
        fixture.executeBatch
          .mockResolvedValueOnce(first)
          .mockResolvedValueOnce(backfillExecution());
      } else if (operation === "rollback") {
        const rollback = {
          ...first,
          result: {
            ...first.result,
            rollback: { removedDiaryEntries: 5, removedStagedEntries: 3 },
          },
        };
        fixture.executeBatch.mockResolvedValueOnce(rollback);
      } else {
        fixture.executeBatch.mockResolvedValueOnce(first);
      }
      const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await runCli([
        "memory",
        "session-backfill",
        ...(operation === "preview" ? [] : [`--${operation}`]),
        "--json",
      ]);
      const result = JSON.parse(String(output.mock.calls.at(-1)?.[0]));
      expect(result).toMatchObject({
        agentId: "main",
        workspaceDir: "/gateway/workspace",
        candidateCount: operation === "apply" ? 8 : 4,
        writtenDiaryEntries: operation === "apply" ? 2 : 1,
        replacedDiaryEntries: operation === "apply" ? 4 : 2,
      });
      expect(result.days[0].topCandidates).toContain("four");
      if (operation === "apply") {
        expect(result.batchCount).toBe(2);
        expect(fixture.callGateway.mock.calls[1]?.[0].params).toMatchObject({
          operationOwnerId: ownerId,
        });
      } else if (operation === "rollback") {
        expect(result.rollback).toEqual({ removedDiaryEntries: 5, removedStagedEntries: 3 });
      }
      expect(fixture.callGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          method: `memory.sessionBackfill.${operation}.owner`,
          params: expect.objectContaining({ expectedOwnerId: ownerId, cliResult: true }),
          requiredMethods: [`memory.sessionBackfill.${operation}.owner`],
          requiredCapabilities: [GATEWAY_SERVER_CAPS.LOCAL_STATE_OWNER_ROUTING],
        }),
      );
      expect(fixture.memory).not.toHaveBeenCalled();
    },
  );

  it.each(["memory", "matrix", "search"] as const)(
    "does not replay %s locally when owner method is missing or dispatch is uncertain",
    async (family) => {
      await occupyState();
      const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      for (const dispatched of [false, true]) {
        fixture.callGateway.mockImplementationOnce(async (options) => {
          if (dispatched) {
            await options.prepareDispatchCurrent?.();
            options.assertDispatchCurrent?.();
          }
          throw new Error(
            dispatched ? "connection closed after dispatch" : "required method missing",
          );
        });
        const operation = runCli(
          family === "memory"
            ? ["memory", "session-backfill", "--apply", "--json"]
            : family === "search"
              ? ["memory", "search", "query", "--json"]
              : ["matrix", "verify", "bootstrap", "--json"],
        );
        const message = dispatched
          ? "No local fallback was attempted"
          : "No local mutation was attempted";
        if (family !== "matrix") {
          await expect(operation).rejects.toThrow(message);
        } else {
          await operation;
          expect(output.mock.calls.at(-1)?.[0]).toContain(message);
          expect(process.exitCode).toBe(1);
        }
      }
      expect(fixture.memory).not.toHaveBeenCalled();
      expect(fixture.bootstrap).not.toHaveBeenCalled();
      expect(fixture.executeBatch).not.toHaveBeenCalled();
      expect(fixture.config).not.toHaveBeenCalled();
      expect(fixture.memoryManager).not.toHaveBeenCalled();
    },
  );

  it.each(["memory", "matrix"] as const)(
    "releases offline %s custody after command failure",
    async (family) => {
      const ownerPath = resolveGatewayLockPaths(process.env).ownerLockPath;
      const failure = async () => {
        expect(readLockPayloadSync(ownerPath, true)).toMatchObject({ role: "agent-embedded" });
        throw new Error("fixture command failure");
      };
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      if (family === "memory") {
        fixture.memory.mockImplementationOnce(failure);
        await expect(runCli(["memory", "index"])).rejects.toThrow("fixture command failure");
      } else {
        fixture.matrix.mockImplementationOnce(failure);
        await runCli(["matrix", "verify", "list", "--json"]);
        expect(process.exitCode).toBe(1);
      }
      expect(fs.existsSync(ownerPath)).toBe(false);
    },
  );

  it.each(["memory", "matrix", "search"] as const)(
    "does not disclose a completed %s result after owner revocation",
    async (family) => {
      await occupyState();
      const entered = createDeferred();
      const finish = createDeferred();
      if (family === "memory") {
        fixture.executeBatch.mockImplementationOnce(async () => {
          entered.resolve();
          await finish.promise;
          return backfillExecution();
        });
      } else if (family === "search") {
        fixture.searchClose.mockImplementationOnce(async () => {
          entered.resolve();
          await finish.promise;
        });
      } else {
        fixture.status.mockImplementationOnce(async () => {
          entered.resolve();
          await finish.promise;
          return { recoveryKey: "synthetic-key-must-not-escape" };
        });
      }
      const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const operation = runCli(
        family === "memory"
          ? ["memory", "session-backfill", "--apply", "--json"]
          : family === "search"
            ? ["memory", "search", "query", "--json"]
            : ["matrix", "verify", "status", "--include-recovery-key", "--json"],
      );
      const outcome = operation.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          operation,
          "Gateway handler did not enter",
        );
        await owner?.release();
        owner = null;
      } finally {
        finish.resolve();
      }
      if (family !== "matrix") {
        expect(await outcome).toMatchObject({ code: "OUTCOME_UNKNOWN" });
        expect(output).not.toHaveBeenCalled();
      } else {
        await outcome;
        expect(process.exitCode).toBe(1);
        expect(output.mock.calls.at(-1)?.[0]).toContain("No local fallback was attempted");
        expect(output.mock.calls.flat().join("")).not.toContain("synthetic-key-must-not-escape");
      }
      expect(fixture.memory).not.toHaveBeenCalled();
    },
  );

  it("does not continue a routed backfill locally when its Gateway stops between batches", async () => {
    await occupyState();
    fixture.executeBatch.mockResolvedValueOnce(
      backfillExecution({ continuation: { advanced: true, hasMore: true } }),
    );
    fixture.callGateway.mockImplementationOnce(async (options) => {
      const reply = await dispatchToGateway(options);
      await owner?.release();
      owner = null;
      return reply;
    });
    await expect(runCli(["memory", "session-backfill", "--apply", "--json"])).rejects.toThrow(
      "The selected Gateway is no longer running",
    );
    expect(fixture.executeBatch).toHaveBeenCalledTimes(1);
    expect(fixture.memory).not.toHaveBeenCalled();
    expect(fs.existsSync(resolveGatewayLockPaths(process.env).ownerLockPath)).toBe(false);
  });

  it("routes memory search limits and JSON output through the discovered owner", async () => {
    await occupyState();
    const hits = [
      {
        path: "memory/fact.md",
        startLine: 1,
        endLine: 2,
        score: 0.8,
        snippet: "A remembered fact",
        source: "memory" as const,
      },
    ];
    fixture.search.mockResolvedValueOnce(hits);
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runCli([
      "memory",
      "search",
      " exact query ",
      "--agent",
      "main",
      "--max-results",
      "75",
      "--min-score",
      "-0.25",
      "--json",
    ]);
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toEqual({ results: hits });
    expect(fixture.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "memory.search.owner",
        requiredMethods: ["memory.search.owner"],
        params: {
          query: " exact query ",
          agentId: "main",
          maxResults: 75,
          minScore: -0.25,
          expectedOwnerId: ownerId,
        },
      }),
    );
    expect(fixture.search).toHaveBeenCalledWith(
      " exact query ",
      expect.objectContaining({ maxResults: 75, minScore: -0.25 }),
    );
    expect(fixture.searchClose).toHaveBeenCalledTimes(1);
    expect(fixture.memory).not.toHaveBeenCalled();
  });

  it.each([undefined, "fixture memory acquisition failed"])(
    "preserves routed unavailable search output for error=%s",
    async (error) => {
      await occupyState();
      fixture.memoryManager.mockResolvedValueOnce({ manager: null, error });
      const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const diagnostics = vi.spyOn(console, "error").mockImplementation(() => undefined);
      await runCli(["memory", "search", "query", "--json"]);
      expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toEqual(
        error
          ? {
              agentId: "main",
              ok: false,
              error: {
                type: "cli_error",
                message: "memory search failed (main): fixture memory acquisition failed",
              },
            }
          : { agentId: "main", status: "disabled" },
      );
      expect(process.exitCode).toBe(error ? 1 : 0);
      if (error) {
        expect(diagnostics.mock.calls.flat().join("")).toContain(
          "memory search failed (main): fixture memory acquisition failed",
        );
      }
      expect(fixture.memory).not.toHaveBeenCalled();
    },
  );
});
