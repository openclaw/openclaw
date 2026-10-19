import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { loadSqliteVecExtension } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, vi } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
  readRequestText,
  respondJson,
} from "../test/helpers/gateway-integration-fixtures.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../test/helpers/openclaw-test-instance.js";
import { runQaGatewayTestFixture } from "../test/helpers/qa-gateway-test-lifetime.js";
import { createTempDirTracker } from "../test/helpers/temp-dir.js";
import { withConsoleLogsRoutedToStderrForJson } from "./cli/json-output-mode.js";
import { CliPluginInvocationResources } from "./cli/plugin-invocation-resources.js";
import type { OpenClawConfig } from "./config/types.js";
import { runMainOrRootHelp } from "./entry.js";
import { openNodeSqliteDatabase } from "./infra/node-sqlite.js";
import { resetLogger, setLoggerOverride } from "./logging/logger.js";
import { createPluginCliLoadSession } from "./plugins/cli-registry-loader.js";
import { registerPluginCliCommandsFromValidatedConfig } from "./plugins/cli.js";
import { createPluginCache, retirePluginCache } from "./plugins/plugin-cache.js";
import { createDeferredCore } from "./shared/deferred.js";

type MemoryRootFixture = {
  workspaceDir: string;
  stdout: () => string;
  stderr: () => string;
  invoke: (args: string[]) => Promise<void>;
};

function memoryConfig(workspace: string, baseUrl?: string): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      defaults: {
        workspace,
        skipBootstrap: baseUrl ? true : undefined,
        heartbeat: baseUrl ? { every: "0m" } : undefined,
        model: baseUrl ? { primary: "fixture/unused" } : undefined,
      },
      entries: { main: {} },
    },
    plugins: {
      allow: ["memory-core"],
      slots: { memory: "memory-core" },
      entries: baseUrl
        ? { "memory-core": { config: { dreaming: { enabled: false } } } }
        : undefined,
    },
    memory: {
      search: baseUrl
        ? {
            provider: "openai-compatible",
            model: "synthetic-embedding",
            fallback: "none",
            sources: ["memory"],
            remote: { baseUrl, apiKey: "fixture-unused-key" },
            query: { minScore: 0.2 },
          }
        : { provider: "none", sources: ["memory"], store: { vector: { enabled: false } } },
    },
    gateway: baseUrl ? { mode: "local", bind: "loopback" } : undefined,
    hooks: baseUrl ? { enabled: false } : undefined,
    tools: baseUrl ? { allow: ["memory_search"] } : undefined,
  };
}

function expectJsonFailure({ stdout, stderr }: MemoryRootFixture, message: string) {
  expect(JSON.parse(stdout())).toEqual({ ok: false, error: { type: "cli_error", message } });
  expect(stderr().trim()).toBe(message);
  expect(process.exitCode).toBe(1);
}

async function withMemoryRoot(run: (fixture: MemoryRootFixture) => Promise<void>) {
  // A later invocation must not adopt roots retained after failed owner drainage.
  const tempDirs = createTempDirTracker();
  const root = tempDirs.make("openclaw-entry-memory-json-");
  const workspaceDir = path.join(root, "workspace");
  const previousExitCode = process.exitCode;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const cache = createPluginCache();
  try {
    await fs.mkdir(workspaceDir, { recursive: true });
    for (const [name, value] of Object.entries({
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      OPENCLAW_DEBUG: "0",
      OPENCLAW_BUNDLED_PLUGINS_DIR: fileURLToPath(new URL("../extensions", import.meta.url)),
    })) {
      vi.stubEnv(name, value);
    }
    // The real early-diagnostic dotenv loader must see only this empty fixture.
    vi.spyOn(process, "cwd").mockReturnValue(root);
    for (const [stream, captured] of [
      [process.stdout, stdout],
      [process.stderr, stderr],
    ] as const) {
      vi.spyOn(stream, "write").mockImplementation((chunk) => {
        captured.push(String(chunk));
        return true;
      });
    }
    setLoggerOverride({ level: "silent", consoleLevel: "error" });
    await fs.writeFile(
      path.join(root, "openclaw.json"),
      JSON.stringify(memoryConfig(workspaceDir)),
    );
    const fixtureEnv = { ...process.env };
    const invoke = async (args: string[]) => {
      const argv = ["node", "openclaw", "memory", ...args];
      stdout.length = 0;
      stderr.length = 0;
      process.exitCode = 0;
      // mock-isolation: Run the real memory command, retaining runCli's root JSON routing.
      vi.doMock("./cli/run-main.js", async () => ({
        runCli: async (commandArgv: string[]) => {
          const program = new Command().name("openclaw").exitOverride();
          const resources = new CliPluginInvocationResources();
          const session = createPluginCliLoadSession(cache, { resources });
          try {
            await session.withCache(async () => {
              await registerPluginCliCommandsFromValidatedConfig(
                program,
                fixtureEnv,
                { pluginSdkResolution: "src" },
                { primary: "memory", session },
              );
              session.close();
              await resources.run(() => program.parseAsync(commandArgv));
            });
          } finally {
            session.close();
            await resources.release();
          }
        },
      }));
      await withConsoleLogsRoutedToStderrForJson(argv, () => runMainOrRootHelp(argv));
    };
    await run({
      workspaceDir,
      stdout: () => stdout.join(""),
      stderr: () => stderr.join(""),
      invoke,
    });
  } finally {
    try {
      try {
        const retirement = await retirePluginCache(cache);
        expect(retirement.failures).toEqual([]);
      } finally {
        await closeOpenClawAgentDatabasesAsync();
        closeOpenClawAgentDatabasesForTest();
        // Agent releases can reopen shared state, so close that owner last.
        await closeOpenClawStateDatabaseAsync();
        resetPluginStateStoreForTests();
      }
    } finally {
      clearRuntimeConfigSnapshot();
      resetLogger();
      vi.doUnmock("./cli/run-main.js");
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      process.exitCode = previousExitCode;
    }
    tempDirs.cleanup();
  }
}

async function prepareHistoricalMemoryControl(
  fixture: MemoryRootFixture,
  command: "rem-harness" | "rem-backfill",
) {
  const { workspaceDir, invoke, stdout } = fixture;
  const historyPath = path.join(workspaceDir, "2025-01-01.md");
  const history =
    "## Preferences Learned\n- Always choose the copper telescope for observations.\n";
  await fs.writeFile(historyPath, history, "utf8");
  const args = [command, "--agent", "main", "--path", historyPath, "--json"];
  await invoke(args);
  expect(JSON.parse(stdout())).toMatchObject({
    sourcePath: historyPath,
    sourceFiles: [historyPath],
    ...(command === "rem-harness"
      ? { historicalImport: { importedFileCount: 1 } }
      : { groundedFiles: 1, writtenEntries: 1 }),
  });
  expect(process.exitCode).toBe(0);
  return { historyPath, history, args };
}

describe("memory command failures at the root JSON boundary", () => {
  it("writes one actionable JSON failure for a queryless search", async () => {
    await withMemoryRoot(async (fixture) => {
      await fixture.invoke(["search", "--json"]);
      expectJsonFailure(
        fixture,
        "Missing search query. Provide a positional query or use --query <text>.",
      );
    });
  });

  it.each(["rem-harness", "rem-backfill"] as const)(
    "%s writes one failure document when historical scratch removal rejects",
    async (command) => {
      await withMemoryRoot(async (fixture) => {
        const { invoke, stdout } = fixture;
        const { historyPath, history, args } = await prepareHistoricalMemoryControl(
          fixture,
          command,
        );
        const realCopyFile = fs.copyFile.bind(fs);
        const realRm = fs.rm.bind(fs);
        const cleanupStarted = createDeferredCore();
        const cleanupRelease = createDeferredCore();
        const cleanupError = new Error("synthetic historical scratch removal denied");
        let scratchDir: string | undefined;
        let cleanupAttempts = 0;
        vi.spyOn(fs, "copyFile").mockImplementation(async (source, destination, mode) => {
          await realCopyFile(source, destination, mode);
          if (source === historyPath && typeof destination === "string") {
            const copiedRoot = path.dirname(path.dirname(destination));
            if (
              path.basename(path.dirname(destination)) === "memory" &&
              path.basename(copiedRoot).startsWith(`openclaw-${command}-`)
            ) {
              scratchDir = copiedRoot;
            }
          }
        });
        vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
          if (scratchDir !== undefined && target === scratchDir) {
            cleanupAttempts += 1;
            cleanupStarted.resolve();
            await cleanupRelease.promise;
            throw cleanupError;
          }
          await realRm(target, options);
        });
        // Observe rejection before racing cleanup so early failures cannot go unhandled.
        const settled = invoke(args);
        void settled.catch(() => {});
        try {
          const first = await Promise.race([
            cleanupStarted.promise.then(() => "cleanup" as const),
            settled.then(() => "settled" as const),
          ]);
          expect(first).toBe("cleanup");
          const beforeRemovalSettled = stdout();
          cleanupRelease.resolve();
          await expect(settled).resolves.toBeUndefined();

          // Parsing the whole stream rejects a success document followed by a failure document.
          expectJsonFailure(fixture, cleanupError.message);
          expect({
            beforeRemovalSettled,
            cleanupAttempts,
            history: await fs.readFile(historyPath, "utf8"),
          }).toEqual({ beforeRemovalSettled: "", cleanupAttempts: 1, history });
        } finally {
          // Restoring the spy cannot settle work already waiting on this promise.
          cleanupRelease.resolve();
          await settled.catch(() => {});
          if (scratchDir !== undefined) {
            await realRm(scratchDir, { recursive: true, force: true });
          }
        }
      });
    },
  );
});

it(
  "Gateway memory_search returns semantic recall before its deadline with chunks-first estimates",
  {
    timeout: 120_000,
  },
  (context) => {
    const query = "How do we restore service after a failed deployment?";
    const documents = [
      [
        "rollback",
        "Revert the release to the previous healthy version when the rollout breaks.",
        0.01,
      ],
      ["traffic", "Route requests back to the healthy replica pool while repairs proceed.", 0.05],
      ["snapshot", "Recover the saved application snapshot and restart the service.", 0.1],
      ["verify", "Check health probes and run a smoke test before reopening traffic.", 0.15],
      ["repair", "Repair the broken release in staging before attempting another rollout.", 0.2],
      ["keyword", "The deployment art exhibition includes a failed sculpture named service.", 1.55],
      ["background", "The botanical catalog describes orchids and garden soil.", 1.57],
    ] as const;
    const vector = (angle: number) => [
      Math.cos(angle),
      Math.sin(angle),
      ...Array<number>(8190).fill(0),
    ];
    const embeddings = new Map<string, number[]>(
      documents.map(([, text, angle]) => [text, vector(angle)]),
    );
    const providerErrors: unknown[] = [];
    let instance: OpenClawTestInstance | undefined;
    const provider = createServer((request, response) => {
      void (async () => {
        const body: { input: string[] } = JSON.parse(await readRequestText(request));
        respondJson(response, {
          data: body.input.map((text, index) => {
            const embedding =
              text === query || text === "ping" ? vector(0) : embeddings.get(text.trim());
            if (!embedding) {
              throw new Error("Unexpected embedding fixture input");
            }
            return { index, embedding };
          }),
        });
      })().catch((error: unknown) => {
        providerErrors.push(error);
        response.writeHead(500).end();
      });
    });
    return runQaGatewayTestFixture(
      context,
      async ({ signal, verifyCleanup, createTempDir }) => {
        const workspace = createTempDir("openclaw-memory-query-plan-");
        await fs.mkdir(path.join(workspace, "memory"));
        for (const [name, text] of documents) {
          await fs.writeFile(path.join(workspace, "memory", `${name}.md`), `${text}\n`);
        }
        const providerUrl = await listenLoopback(provider);
        instance = await createOpenClawTestInstance({
          name: "memory-query-plan",
          entrypoint: [path.resolve("openclaw.mjs")],
          signal,
          verifyCleanup,
          config: memoryConfig(workspace, `${providerUrl}/v1`),
          env: {
            VITEST: undefined,
            NODE_ENV: undefined,
            OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
            OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
            OPENCLAW_NO_RESPAWN: "1",
          },
        });
        const indexed = await instance.cli(["memory", "index", "--agent", "main", "--force"]);
        expect(indexed.code, indexed.stderr).toBe(0);
        const databasePath = path.join(instance.state.agentDir("main"), "openclaw-agent.sqlite");
        const db = openNodeSqliteDatabase(databasePath, { allowExtension: true });
        try {
          const loaded = await loadSqliteVecExtension({ db });
          expect(loaded.ok, loaded.error).toBe(true);
          const insert = db.prepare(`INSERT INTO memory_index_chunks
          (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
          SELECT ?, path, source, start_line, end_line, hash, model, text, embedding, updated_at
          FROM memory_index_chunks WHERE path = 'memory/background.md' LIMIT 1`);
          const insertVector = db.prepare(
            "INSERT INTO memory_index_chunks_vec (id, embedding) VALUES (?, ?)",
          );
          const insertProvenance = db.prepare(`INSERT INTO memory_index_chunk_provenance
          (chunk_id, origin_class, session_kind, observed_at) VALUES (?, 'agent', 'unknown', ?)`);
          const insertRecall = db.prepare(
            "INSERT INTO memory_index_chunk_recall_metadata (chunk_id) VALUES (?)",
          );
          const background = new Uint8Array(new Float32Array(vector(1.57)).buffer);
          db.exec("BEGIN");
          // Wide vectors make repeated KNN work expensive without a large chunk scan after the fix.
          for (let index = documents.length; index < 4096; index += 1) {
            const id = `padding-${index}`;
            insert.run(id);
            insertVector.run(id, background);
            insertProvenance.run(id, Date.now());
            insertRecall.run(id);
          }
          db.exec("COMMIT; ANALYZE");
          db.exec(
            "UPDATE sqlite_stat1 SET stat = '1 1' WHERE tbl = 'memory_index_chunks'; ANALYZE sqlite_schema;",
          );
          expect(db.prepare("SELECT count(*) AS count FROM memory_index_chunks").get()).toEqual({
            count: 4096,
          });
        } finally {
          db.close();
        }
        await instance.startGateway();
        const startedAt = performance.now();
        const response = await fetch(`http://127.0.0.1:${instance.port}/tools/invoke`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${instance.gatewayToken}`,
          },
          body: JSON.stringify({
            tool: "memory_search",
            agentId: "main",
            args: { query, maxResults: 5, corpus: "memory" },
          }),
          signal,
        });
        const responseBody: unknown = await response.json();
        const elapsedMs = performance.now() - startedAt;
        console.info(JSON.stringify({ elapsedMs, responseBody, providerErrors }));
        expect(response.status).toBe(200);
        expect(responseBody).toMatchObject({
          ok: true,
          result: {
            details: {
              results: ["snapshot", "verify", "traffic", "repair", "rollback"].map((name) => ({
                path: `memory/${name}.md`,
                source: "memory",
                vectorScore: expect.any(Number),
              })),
            },
          },
        });
        expect(responseBody).not.toHaveProperty("result.details.partial");
        expect(responseBody).not.toHaveProperty("result.details.timedOut");
        expect(providerErrors).toEqual([]);
        const after = openNodeSqliteDatabase(databasePath, { readOnly: true });
        try {
          expect(after.prepare("SELECT count(*) AS count FROM memory_index_chunks").get()).toEqual({
            count: 4096,
          });
        } finally {
          after.close();
        }
      },
      async () => instance?.cleanup(),
      async () => {
        if (provider.listening) {
          await closeHttpServer(provider);
        }
      },
    );
  },
);
