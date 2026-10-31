import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetConfigRuntimeState } from "../config/config.js";
import type { CallGatewayOptions } from "../gateway/call.js";
import { runWithLocalStateMutationOwner } from "../gateway/server-methods/local-state-owner.js";
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
import type { MemoryCliSearchOutcome, MemorySearchManager } from "../memory-host-sdk/host/types.js";
import { runWithLocalStateOwner } from "../plugin-sdk/cli-state-owner.js";
import { createTestPluginApi } from "../plugin-sdk/plugin-test-api.js";
import { createPluginRuntimeMock } from "../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import type { OpenClawPluginApi } from "../plugins/plugin-api.types.js";
import type { OpenClawPluginCliRegistrar } from "../plugins/plugin-registration.types.js";
import type { MemoryPluginRuntime } from "../plugins/registry-contribution-types.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { writeFixtureJsonSync } from "./cli-fixtures.test-support.js";

const fixture = vi.hoisted(() => ({
  external: false,
  callGateway: vi.fn<(options: CallGatewayOptions) => Promise<unknown>>(),
  executeBatch: vi.fn<() => Promise<ReturnType<typeof backfillExecution>>>(),
  memoryManager: vi.fn(),
  search: vi.fn<MemorySearchManager["search"]>(),
  searchClose: vi.fn(async () => {}),
  status: vi.fn(),
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

vi.mock("../infra/gateway-state-owner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/gateway-state-owner.js")>();
  return {
    ...actual,
    // Model the external CLI's absent process-local owner; retain real lock discovery.
    captureGatewayStateOwner: (...args: Parameters<typeof actual.captureGatewayStateOwner>) =>
      fixture.external ? undefined : actual.captureGatewayStateOwner(...args),
  };
});

const { createMemoryRuntime: createCliMemoryRuntime } = await vi.importActual<{
  createMemoryRuntime: (host: object) => {
    searchForCli: NonNullable<MemoryPluginRuntime["searchForCli"]>;
  };
}>("../../extensions/memory-core/runtime-api.js");
const searchForCli = createCliMemoryRuntime({}).searchForCli;

// Synthetic command families retain the caller shapes.
// Admission, physical custody, transport dispatch, and response revocation stay real.
function registerSyntheticPlugin(api: OpenClawPluginApi) {
  const registerOwnedMethod = (
    method: string,
    run: (params: Record<string, unknown>) => Promise<unknown>,
  ) => {
    api.registerGatewayMethod(method, async (options) => {
      try {
        const params = options.params as Record<string, unknown>;
        const result = await runWithLocalStateMutationOwner(
          String(params.expectedOwnerId),
          options,
          () => run(params),
        );
        options.respond(true, result);
      } catch (error) {
        options.respond(false, undefined, { code: "UNAVAILABLE", message: String(error) });
      }
    });
  };
  registerOwnedMethod("fixture.batch.apply.owner", async (params) => ({
    execution: await fixture.executeBatch(),
    ownerId: params.expectedOwnerId,
  }));
  registerOwnedMethod("fixture.verify.status.owner", async (params) => ({
    result: await fixture.status({
      cfg: api.runtime.config.current(),
      accountId: params.accountId,
    }),
    accountId: params.accountId,
  }));
  api.registerCli(({ program }) => {
    program
      .command("memory <operation> [value]")
      .allowUnknownOption()
      .allowExcessArguments()
      .option("--apply")
      .option("--json")
      .option("--agent <id>")
      .option("--max-results <n>", "limit", Number)
      .option("--min-score <n>", "score", Number)
      .action(
        async (
          operation: string,
          value: string | undefined,
          opts: {
            agent?: string;
            maxResults?: number;
            minScore?: number;
          },
        ) => {
          if (operation === "session-backfill") {
            await runSyntheticBatches();
          } else if (operation === "search") {
            const result = await runWithLocalStateOwner<MemoryCliSearchOutcome | undefined>({
              method: "memory.search.owner",
              target: "fixture search",
              databaseEngine: "configured",
              params: {
                query: value,
                ...(opts.agent === undefined ? {} : { agentId: opts.agent }),
                ...(opts.maxResults === undefined ? {} : { maxResults: opts.maxResults }),
                ...(opts.minScore === undefined ? {} : { minScore: opts.minScore }),
              },
              runLocal: async () => {
                await fixture.memory();
                return undefined;
              },
            });
            if (result) {
              if ("status" in result && result.status === "failed") {
                const message = `memory search failed (${result.agentId}): ${result.error}`;
                console.error(message);
                process.exitCode = 1;
                printJson({
                  agentId: result.agentId,
                  ok: false,
                  error: { type: "cli_error", message },
                });
              } else {
                printJson(result);
              }
            }
          } else {
            await runWithLocalStateOwner({
              method: "fixture.offline",
              target: "fixture stores",
              params: {},
              onForeignOwner: "refuse",
              runLocal: fixture.memory,
            });
          }
        },
      );
    program
      .command("matrix")
      .command("verify <operation> [value]")
      .option("--json")
      .option("--account <id>")
      .option("--include-recovery-key")
      .action(async (operation: string, _value: string | undefined, opts: { account?: string }) => {
        try {
          const result = await runWithLocalStateOwner<{ result: unknown }>({
            method: `fixture.verify.${operation}.owner`,
            target: "fixture account",
            params: { accountId: opts.account },
            runLocal: async () => {
              fixture.config();
              return { result: await fixture.matrix() };
            },
          });
          printJson(result.result);
        } catch (error) {
          process.exitCode = 1;
          printJson({ error: String(error) });
        }
      });
  });
}

function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function runSyntheticBatches() {
  let operationOwnerId: string | undefined;
  const batches: ReturnType<typeof backfillExecution>["result"][] = [];
  for (;;) {
    const reply = await runWithLocalStateOwner<{
      execution: ReturnType<typeof backfillExecution>;
      ownerId: string;
    } | null>({
      method: "fixture.batch.apply.owner",
      target: "fixture batches",
      params: { cliResult: true, ...(operationOwnerId ? { operationOwnerId } : {}) },
      runLocal: async () => {
        if (operationOwnerId) {
          throw new Error("The selected Gateway is no longer running");
        }
        await fixture.memory();
        return null;
      },
    });
    if (!reply) {
      return;
    }
    operationOwnerId ??= reply.ownerId;
    batches.push(reply.execution.result);
    if (!reply.execution.continuation.hasMore) {
      break;
    }
  }
  const result = { ...batches[0], batchCount: batches.length };
  for (const field of ["candidateCount", "writtenDiaryEntries", "replacedDiaryEntries"] as const) {
    result[field] = batches.reduce((sum, batch) => sum + batch[field], 0);
  }
  printJson(result);
}

const roots = useAutoCleanupTempDirTracker(afterAll);
let root: string;
let owner: GatewayLockHandle | null = null;
let ownerId: string | undefined;
let registrar: OpenClawPluginCliRegistrar;
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
    registerCli(value) {
      registrar = value;
    },
    registerGatewayMethod: (name, handler) => {
      methods.set(name, handler);
    },
  });
  registerSyntheticPlugin(api);
  for (const [method, handler] of Object.entries(memorySearchHandlers)) {
    methods.set(method, handler);
  }
});

beforeEach(() => {
  fs.writeFileSync(path.join(root, "openclaw.json"), "{}\n");
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
    searchForCli,
  });
  fixture.status.mockReset();
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
  await registrar({
    program,
    parentPath: [],
    config: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
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

describe("synthetic plugin commands respect the local state owner", () => {
  it("refuses offline memory access while the Gateway owns state", async () => {
    await occupyState();
    await expect(runCli(["memory", "status"])).rejects.toThrow("exclusive offline state ownership");
    expect(fixture.memory).not.toHaveBeenCalled();
  });

  it("retains offline memory ownership until the command settles", async () => {
    const entered = createDeferred();
    const finish = createDeferred();
    const ownerPath = resolveGatewayLockPaths(process.env).ownerLockPath;
    fixture.memory.mockImplementationOnce(async () => {
      entered.resolve();
      await finish.promise;
      expect(readLockPayloadSync(ownerPath, true)).toMatchObject({
        pid: process.pid,
        role: "agent-embedded",
      });
    });
    const operation = runCli(["memory", "index"]);
    try {
      await awaitGateBeforeSettlement(entered.promise, operation, "command did not enter");
      expect(readLockPayloadSync(ownerPath, true)).toMatchObject({ role: "agent-embedded" });
    } finally {
      finish.resolve();
      await operation;
    }
    expect(process.exitCode).toBe(0);
    expect(fs.existsSync(ownerPath)).toBe(false);
  });

  it("does not replay search locally when owner method is missing or dispatch is uncertain", async () => {
    await occupyState();
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
      await expect(runCli(["memory", "search", "query", "--json"])).rejects.toThrow(
        dispatched ? "No local fallback was attempted" : "No local mutation was attempted",
      );
    }
    expect(fixture.memory).not.toHaveBeenCalled();
    expect(fixture.executeBatch).not.toHaveBeenCalled();
    expect(fixture.memoryManager).not.toHaveBeenCalled();
  });

  it("releases offline memory custody after command failure", async () => {
    const ownerPath = resolveGatewayLockPaths(process.env).ownerLockPath;
    fixture.memory.mockImplementationOnce(async () => {
      expect(readLockPayloadSync(ownerPath, true)).toMatchObject({ role: "agent-embedded" });
      throw new Error("fixture command failure");
    });
    await expect(runCli(["memory", "index"])).rejects.toThrow("fixture command failure");
    expect(fs.existsSync(ownerPath)).toBe(false);
  });

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
        fixture.search.mockImplementationOnce(async () => {
          entered.resolve();
          await finish.promise;
          return [];
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

  it("routes configured memory search and options without local database credentials", async () => {
    await occupyState();
    vi.stubEnv("MISSING_ROUTED_CLI_DATABASE_DSN", undefined);
    writeFixtureJsonSync(path.join(root, "openclaw.json"), {
      database: {
        engine: "postgres",
        postgres: {
          connection: {
            source: "env",
            provider: "default",
            id: "MISSING_ROUTED_CLI_DATABASE_DSN",
          },
        },
      },
    });
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
});
