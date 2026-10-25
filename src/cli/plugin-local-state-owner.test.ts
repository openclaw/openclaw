import fs from "node:fs";
import path from "node:path";
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
import type { MemoryPluginRuntime } from "../plugins/registry-contribution-types.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";

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

// Exercise the SDK boundary directly; a synthetic Commander plugin cannot prove CLI wiring.
function runOffline() {
  return runWithLocalStateOwner({
    method: "fixture.offline",
    target: "fixture stores",
    params: {},
    onForeignOwner: "refuse",
    runLocal: fixture.memory,
  });
}

async function runSearch(params: {
  query: string;
  agentId?: string;
  maxResults?: number;
  minScore?: number;
}) {
  const result = await runWithLocalStateOwner<MemoryCliSearchOutcome | undefined>({
    method: "memory.search.owner",
    target: "fixture search",
    databaseEngine: "configured",
    params,
    runLocal: async () => {
      await fixture.memory();
      return undefined;
    },
  });
  if (result) {
    printJson(result);
  }
}

async function runStatus() {
  try {
    const result = await runWithLocalStateOwner<{ result: unknown }>({
      method: "fixture.verify.status.owner",
      target: "fixture account",
      params: {},
      runLocal: async () => ({ result: await fixture.matrix() }),
    });
    printJson(result.result);
  } catch (error) {
    process.exitCode = 1;
    printJson({ error: String(error) });
  }
}

function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function runSyntheticBatches() {
  let operationOwnerId: string | undefined;
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
    if (!reply.execution.continuation.hasMore) {
      printJson(reply.execution.result);
      return;
    }
  }
}

const roots = useAutoCleanupTempDirTracker(afterAll);
let root: string;
let owner: GatewayLockHandle | null = null;
let ownerId: string | undefined;
const ownedHandler =
  (run: (options: GatewayRequestHandlerOptions) => Promise<unknown>): GatewayRequestHandler =>
  async (options) => {
    try {
      options.respond(
        true,
        await runWithLocalStateMutationOwner(String(options.params?.expectedOwnerId), options, () =>
          run(options),
        ),
      );
    } catch (error) {
      options.respond(false, undefined, { code: "UNAVAILABLE", message: String(error) });
    }
  };
const methods: Record<string, GatewayRequestHandler> = {
  ...memorySearchHandlers,
  "fixture.batch.apply.owner": ownedHandler(async ({ params }) => ({
    execution: await fixture.executeBatch(),
    ownerId: params?.expectedOwnerId,
  })),
  "fixture.verify.status.owner": ownedHandler(async () => ({ result: await fixture.status() })),
};
const gatewayConfig = {
  plugins: { entries: { "memory-core": { config: { dreaming: { enabled: false } } } } },
  agents: { entries: { main: {} } },
};

async function dispatchToGateway(options: CallGatewayOptions) {
  await options.prepareDispatchCurrent?.();
  options.assertDispatchCurrent?.();
  const handler = methods[options.method];
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
      candidateCount: 4,
      writtenDiaryEntries: 1,
      replacedDiaryEntries: 2,
    },
    continuation: { advanced: true, hasMore: false },
    ...overrides,
  };
}

beforeAll(() => {
  root = roots.make("openclaw-plugin-cli-owner-");
});

beforeEach(() => {
  fs.writeFileSync(path.join(root, "openclaw.json"), "{}\n");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
  resetConfigRuntimeState();
  fixture.external = false;
  fixture.memory.mockClear();
  fixture.matrix.mockClear();
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

describe("plugin SDK calls respect the local state owner", () => {
  it("releases offline memory custody after command failure", async () => {
    const ownerPath = resolveGatewayLockPaths(process.env).ownerLockPath;
    fixture.memory.mockImplementationOnce(async () => {
      expect(readLockPayloadSync(ownerPath, true)).toMatchObject({ role: "agent-embedded" });
      throw new Error("fixture command failure");
    });
    await expect(runOffline()).rejects.toThrow("fixture command failure");
    expect(fs.existsSync(ownerPath)).toBe(false);
  });

  it.each(["memory", "matrix", "search"] as const)(
    "does not disclose a completed %s result after owner revocation",
    async (family) => {
      await occupyState();
      const entered = createDeferred();
      const finish = createDeferred();
      const blockUntilReleased =
        <T>(result: T) =>
        async () => {
          entered.resolve();
          await finish.promise;
          return result;
        };
      if (family === "memory") {
        fixture.executeBatch.mockImplementationOnce(blockUntilReleased(backfillExecution()));
      } else if (family === "search") {
        fixture.search.mockImplementationOnce(blockUntilReleased([]));
      } else {
        fixture.status.mockImplementationOnce(
          blockUntilReleased({ recoveryKey: "synthetic-key-must-not-escape" }),
        );
      }
      const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const operation =
        family === "memory"
          ? runSyntheticBatches()
          : family === "search"
            ? runSearch({ query: "query" })
            : runStatus();
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
    await expect(runSyntheticBatches()).rejects.toThrow(
      "The selected Gateway is no longer running",
    );
    expect(fixture.executeBatch).toHaveBeenCalledTimes(1);
    expect(fixture.memory).not.toHaveBeenCalled();
    expect(fs.existsSync(resolveGatewayLockPaths(process.env).ownerLockPath)).toBe(false);
  });

  it("routes configured memory search and options without local database credentials", async () => {
    await occupyState();
    vi.stubEnv("MISSING_ROUTED_CLI_DATABASE_DSN", undefined);
    fs.writeFileSync(
      path.join(root, "openclaw.json"),
      JSON.stringify({
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
      }),
    );
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
    await runSearch({ query: " exact query ", agentId: "main", maxResults: 75, minScore: -0.25 });
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
