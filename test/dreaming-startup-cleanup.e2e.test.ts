// A real Gateway restart must remove interrupted Dreaming sessions from its public session list.
import { afterEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../src/config/runtime-snapshot.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { listSessionEntries, upsertSessionEntry } from "../src/plugin-sdk/session-store-runtime.js";
import {
  appendSqliteSessionTranscriptEventForTest,
  closeOpenClawAgentDatabasesForTest,
} from "../src/plugin-sdk/sqlite-runtime-testing.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const STALE_AGE_MS = 600_000;
const WAIT_OPTIONS = { interval: 50, timeout: 15_000 } as const;
let instanceToCleanUp: OpenClawTestInstance | undefined;

type GatewaySessionClient = Awaited<ReturnType<typeof connectGatewayClient>>;

afterEach(async () => {
  await instanceToCleanUp?.cleanup();
  instanceToCleanUp = undefined;
  closeOpenClawAgentDatabasesForTest();
  clearRuntimeConfigSnapshot();
});

async function seedSession(
  suffix: string,
  overrides: {
    agentId?: string;
    updatedAt?: number;
    pluginOwnerId?: string | null;
    transcript?: boolean;
  } = {},
): Promise<string> {
  const {
    agentId = "main",
    updatedAt = Date.now() - STALE_AGE_MS,
    pluginOwnerId = "memory-core",
    transcript = false,
  } = overrides;
  const sessionKey = `agent:${agentId}:${suffix}`;
  const sessionId = `${agentId}-${suffix}`;
  await upsertSessionEntry({
    agentId,
    sessionKey,
    entry: { sessionId, updatedAt, ...(pluginOwnerId ? { pluginOwnerId } : {}) },
  });
  if (transcript) {
    await appendSqliteSessionTranscriptEventForTest({
      agentId,
      sessionId,
      sessionKey,
      event: {
        runId: `dreaming-narrative-${sessionId}`,
        timestamp: updatedAt,
        type: "metadata",
      },
    });
  }
  return sessionKey;
}

async function listSessionKeys(client: GatewaySessionClient): Promise<string[]> {
  const result = await client.request<{ sessions: Array<{ key: string }> }>("sessions.list", {
    includeGlobal: true,
    includeUnknown: true,
    limit: 100,
  });
  return result.sessions.map(({ key }) => key);
}

async function connect(instance: OpenClawTestInstance): Promise<GatewaySessionClient> {
  return await connectGatewayClient({
    url: instance.url,
    token: instance.gatewayToken,
    role: "operator",
    scopes: ["operator.admin", "operator.read", "operator.write"],
  });
}

it("removes stale child sessions after a real restart even when dreaming and cron are disabled", async () => {
  const config = {
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "main" } },
      entries: { main: {}, worker: {} },
    },
    plugins: {
      enabled: true,
      allow: ["memory-core"],
      slots: { memory: "memory-core" },
      entries: { "memory-core": { enabled: true, config: { dreaming: { enabled: false } } } },
    },
  } satisfies OpenClawConfig;
  const instance = await createOpenClawTestInstance({
    name: "dreaming-startup-cleanup",
    config,
    env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
  });
  instanceToCleanUp = instance;
  instance.state.applyEnv();
  setRuntimeConfigSnapshot(config);
  expect(instance.env.OPENCLAW_SKIP_CRON).toBe("1");

  const sentinel = await seedSession("dreaming-narrative-startup-sentinel");
  await instance.startGateway();
  let client = await connect(instance);

  try {
    // Observe the Gateway's sweep through its owner, not this process's cached projection.
    await vi.waitFor(async () => {
      expect(await listSessionKeys(client), instance.logs()).not.toContain(sentinel);
    }, WAIT_OPTIONS);

    // The serving Gateway owns its resident projection. Seed persisted rows only
    // after it stops, so the next process admits them through startup.
    await disconnectGatewayClient(client);
    await instance.stopGateway();
    // The child owned these databases; parent seeds cannot reuse pre-handoff admission proof.
    closeOpenClawAgentDatabasesForTest(instance.state.root);

    const now = Date.now();
    const stale = await Promise.all([
      ...["light", "rem", "deep", "consolidation"].map(async (phase) =>
        seedSession(`dreaming-narrative-${phase}-interrupted`, {
          transcript: true,
          pluginOwnerId: phase === "rem" ? null : "memory-core",
        }),
      ),
      seedSession("dreaming-narrative-worker-interrupted", { agentId: "worker" }),
    ]);
    const preserved = await Promise.all([
      seedSession("dreaming-narrative-active-with-transcript", {
        updatedAt: now,
        transcript: true,
      }),
      seedSession("dreaming-narrative-active-before-transcript", { updatedAt: now }),
      seedSession("dreaming-narrative-foreign", {
        pluginOwnerId: "other-plugin",
        transcript: true,
      }),
      seedSession("telegram:group:dreaming-narrative-conversation", { pluginOwnerId: null }),
    ]);

    const seededKeys = ["main", "worker"].flatMap((agentId) =>
      listSessionEntries({ agentId, readOnly: true }).map(({ sessionKey }) => sessionKey),
    );
    expect(seededKeys).toEqual(expect.arrayContaining([...stale, ...preserved]));

    await instance.startGateway();
    client = await connect(instance);

    await vi.waitFor(async () => {
      const keys = await listSessionKeys(client);
      expect(keys, instance.logs()).toEqual(expect.arrayContaining(preserved));
      for (const sessionKey of stale) {
        expect(keys, instance.logs()).not.toContain(sessionKey);
      }
    }, WAIT_OPTIONS);
  } finally {
    await disconnectGatewayClient(client).catch(() => undefined);
  }
}, 180_000);
