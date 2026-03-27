/**
 * Timed cold vs warm `sessions.list` for cache evidence.
 * Default `pnpm test` may hide `console.log`; to print timings:
 * `npx vitest run src/gateway/sessions-list-cache-bench.test.ts -c vitest.gateway.config.ts --disable-console-intercept`
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import { clearSessionsListResultCacheForTest } from "./sessions-list-result-cache.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let harness: GatewayServerHarness;
let sharedSessionStoreDir: string;
let sessionStoreCaseSeq = 0;

beforeAll(async () => {
  harness = await startGatewayServerHarness();
  sharedSessionStoreDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-bench-"));
});

afterAll(async () => {
  await harness.close();
  await fs.rm(sharedSessionStoreDir, { recursive: true, force: true });
});

const openClient = async (opts?: Parameters<typeof connectOk>[1]) => await harness.openClient(opts);

async function createSessionStoreDir() {
  const dir = path.join(sharedSessionStoreDir, `case-${sessionStoreCaseSeq++}`);
  await fs.mkdir(dir, { recursive: true });
  const storePath = path.join(dir, "sessions.json");
  testState.sessionStorePath = storePath;
  return { dir, storePath };
}

async function writeSingleLineSession(dir: string, sessionId: string, content: string) {
  await fs.writeFile(
    path.join(dir, `${sessionId}.jsonl`),
    `${JSON.stringify({ role: "user", content })}\n`,
    "utf-8",
  );
}

const BENCH_SESSION_COUNT = 20;

test("benchmark: sessions.list cache cold vs warm", async () => {
  clearSessionsListResultCacheForTest();
  const { dir } = await createSessionStoreDir();

  const entries: Record<string, { sessionId: string; updatedAt: number }> = {
    main: { sessionId: "sess-bench-0", updatedAt: Date.now() },
  };
  await writeSingleLineSession(dir, "sess-bench-0", "hello");
  for (let i = 1; i < BENCH_SESSION_COUNT; i++) {
    const sessionId = `sess-bench-${i}`;
    entries[`dashboard:${i}`] = { sessionId, updatedAt: Date.now() - i };
    await writeSingleLineSession(dir, sessionId, "hello");
  }

  await writeSessionStore({ entries });

  const { ws } = await openClient();
  const params = { includeGlobal: true, includeUnknown: true };

  const t1 = performance.now();
  const r1 = await rpcReq<{
    hash?: string;
    sessions?: unknown[];
    unchanged?: boolean;
  }>(ws, "sessions.list", params);
  const cold = performance.now() - t1;

  expect(r1.ok).toBe(true);
  expect(r1.payload?.hash).toMatch(/^[0-9a-f]{16}$/);

  const t2 = performance.now();
  const r2 = await rpcReq<{
    hash?: string;
    unchanged?: boolean;
  }>(ws, "sessions.list", { ...params, lastHash: r1.payload?.hash });
  const warm = performance.now() - t2;

  const t3 = performance.now();
  const r3 = await rpcReq<{
    hash?: string;
    unchanged?: boolean;
  }>(ws, "sessions.list", { ...params, lastHash: r2.payload?.hash });
  const warm2 = performance.now() - t3;

  expect(r2.ok).toBe(true);
  expect(r3.ok).toBe(true);
  expect(r2.payload?.unchanged).toBe(true);
  expect(r3.payload?.unchanged).toBe(true);
  expect(warm).toBeLessThan(cold);

  console.log(`Cold:  ${cold.toFixed(1)}ms`);
  console.log(`Warm:  ${warm.toFixed(1)}ms`);
  console.log(`Warm2: ${warm2.toFixed(1)}ms`);
  console.log(`Speedup: ${((1 - warm / cold) * 100).toFixed(0)}%`);

  ws.close();
});
