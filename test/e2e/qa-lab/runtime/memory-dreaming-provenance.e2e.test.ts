import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, test } from "vitest";
import {
  createQaGatewayChild,
  startQaMockOpenAiServer,
  type MockOpenAiRequestSnapshot,
  type QaGatewayChild,
} from "../../../../extensions/qa-lab/api.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import type { OpenClawConfig } from "../../../../src/plugin-sdk/config-contracts.js";
import { MEMORY_DREAMING_SYSTEM_EVENT_TEXT } from "../../../../src/plugin-sdk/memory-core-host-status.js";
import { readMemoryHostEventRecords } from "../../../../src/plugin-sdk/memory-host-events.js";
import { withinTest } from "../../../helpers/promise.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

const RESTRICTED_MARKER = "SESSION_MEMORY_RESTRICTED_MARKER";
const LEGACY_MARKER = "LEGACY_MEMORY_GRANDFATHERED_MARKER";
const EXPLICIT_OWNER_MARKER = "EXPLICIT_OWNER_CONSOLIDATION_MARKER";
const WAIT_TIMEOUT_MS = 30_000;

type GatewayHandle = QaGatewayChild;
type MockHandle = Awaited<ReturnType<typeof startQaMockOpenAiServer>>;
type RpcClient = Awaited<ReturnType<typeof connectGatewayClient>>;

let gatewayOwner: ReturnType<typeof createQaGatewayChild> | undefined;
let gateway: GatewayHandle | undefined;
let mock: MockHandle | undefined;
let restrictedClient: RpcClient | undefined;

afterEach(async () => {
  const cleanups = [
    gatewayOwner ? stopQaGatewayFixture(gatewayOwner) : undefined,
    mock?.stop().catch(() => undefined),
    restrictedClient ? disconnectGatewayClient(restrictedClient).catch(() => undefined) : undefined,
  ].filter((cleanup): cleanup is Promise<void> => cleanup !== undefined);
  gateway = undefined;
  gatewayOwner = undefined;
  mock = undefined;
  restrictedClient = undefined;
  await Promise.all(cleanups);
});

// Detached session-memory writes and remote cron state expose no completion
// promise to this client. Observe their facts until Vitest cancels the test.
async function waitFor<T>(
  signal: AbortSignal,
  label: string,
  read: () => Promise<T | undefined>,
): Promise<T> {
  try {
    for (;;) {
      const value = await withinTest(Promise.resolve().then(read), signal);
      if (value !== undefined) {
        return value;
      }
      await sleep(100, undefined, { signal });
    }
  } catch (error) {
    if (signal.aborted) {
      throw new Error(`timed out waiting for ${label}${gateway ? `\n${gateway.logs()}` : ""}`, {
        cause: error,
      });
    }
    throw error;
  }
}

async function sendAndWait(params: {
  call: GatewayHandle["call"];
  message: string;
  sessionKey: string;
}): Promise<void> {
  const started = (await params.call("chat.send", {
    sessionKey: params.sessionKey,
    message: params.message,
    deliver: false,
    idempotencyKey: randomUUID(),
  })) as { runId?: unknown; status?: unknown };
  if (typeof started.runId !== "string") {
    return;
  }
  const terminal = (await params.call(
    "agent.wait",
    { runId: started.runId, timeoutMs: WAIT_TIMEOUT_MS },
    { timeoutMs: WAIT_TIMEOUT_MS + 5_000 },
  )) as { status?: unknown };
  expect(terminal.status).toBe("ok");
}

function configureMemoryProof(
  cfg: OpenClawConfig,
  deep: {
    enabled: boolean;
    limit: number;
    minScore: number;
    minRecallCount?: number;
    minUniqueQueries?: number;
  } = { enabled: true, limit: 20, minScore: 1 },
): OpenClawConfig {
  // The Gateway supplies a fresh config to this fixture-owned mutation callback.
  const defaults = ((cfg.agents ??= {}).defaults ??= {});
  ((defaults.compaction ??= {}).memoryFlush ??= {}).enabled = false;
  const hooks = ((cfg.hooks ??= {}).internal ??= {});
  hooks.enabled = true;
  (hooks.entries ??= {})["session-memory"] = { enabled: true, llmSlug: false, messages: 15 };
  const plugins = (cfg.plugins ??= {});
  plugins.allow = [...new Set([...(plugins.allow ?? []), "memory-core"])];
  (plugins.slots ??= {}).memory = "none";
  (plugins.entries ??= {})["memory-core"] = {
    enabled: true,
    config: {
      dreaming: {
        enabled: true,
        verboseLogging: true,
        timezone: "UTC",
        storage: { mode: "inline", separateReports: false },
        phases: {
          light: { enabled: true, limit: 20, lookbackDays: 2 },
          rem: { enabled: false },
          deep,
        },
      },
    },
  };
  return cfg;
}

function configureExplicitOwnerProof(cfg: OpenClawConfig): OpenClawConfig {
  const configured = configureMemoryProof(cfg, {
    enabled: true,
    limit: 20,
    minScore: 0,
    minRecallCount: 1,
    minUniqueQueries: 1,
  });
  const workspace = configured.agents?.defaults?.workspace;
  if (!workspace) {
    throw new Error("QA memory proof requires a default workspace");
  }
  const search = ((configured.memory ??= {}).search ??= {});
  search.provider = "none";
  search.model = "";
  search.sources = ["memory"];
  ((search.store ??= {}).vector ??= {}).enabled = false;
  (search.query ??= {}).minScore = 0;
  const agents = (configured.agents ??= {});
  agents.ownership = "explicit";
  (agents.defaults ??= {}).systemAgent = { agentId: "researcher" };
  (agents.entries ??= {}).researcher = { workspace };
  ((configured.plugins ??= {}).slots ??= {}).memory = "memory-core";
  return configured;
}

async function startMemoryGateway(
  mutateConfig: (cfg: OpenClawConfig) => OpenClawConfig,
  provider = "openai",
  mockAuthAgentIds?: string[],
) {
  mock = await startQaMockOpenAiServer();
  gatewayOwner = createQaGatewayChild();
  gateway = await gatewayOwner.start({
    repoRoot: path.resolve(import.meta.dirname, "../../../.."),
    providerBaseUrl: `${mock.baseUrl}/v1`,
    providerMode: "mock-openai",
    // Cron captures a stored account; the QA harness stages one for openai.
    primaryModel: `${provider}/gpt-5.6-luna`,
    alternateModel: `${provider}/gpt-5.6-luna-alt`,
    transportBaseUrl: "http://127.0.0.1:9",
    controlUiEnabled: false,
    enabledPluginIds: ["memory-core"],
    mockAuthAgentIds,
    mutateConfig,
  });
  return gateway;
}

async function requestCursor(): Promise<number> {
  const result = (await fetch(`${mock?.baseUrl}/debug/request-cursor`).then((response) =>
    response.json(),
  )) as { cursor?: unknown };
  expect(typeof result.cursor).toBe("number");
  return result.cursor as number;
}

async function runDreaming(signal: AbortSignal, activeGateway: GatewayHandle, id: unknown) {
  expect(typeof id).toBe("string");
  const started = (await activeGateway.call("cron.run", { id, mode: "force" })) as {
    runId?: unknown;
  };
  expect(typeof started.runId).toBe("string");
  const completed = await waitFor(signal, "completed dreaming cron", async () => {
    const history = (await activeGateway.call("cron.runs", {
      id,
      runId: started.runId,
      limit: 1,
    })) as { entries?: Array<{ runId?: unknown; status?: unknown; error?: unknown }> };
    return history.entries?.find((entry) => entry.runId === started.runId);
  });
  expect(completed).toMatchObject({ status: "ok" });
}

function waitForRequest(
  signal: AbortSignal,
  cursor: number,
  matches: (request: MockOpenAiRequestSnapshot) => boolean,
) {
  return waitFor(signal, "dreaming provider request", async () => {
    const response = await fetch(`${mock?.baseUrl}/debug/requests?after=${cursor}`);
    if (!response.ok) {
      throw new Error(`mock request log returned ${response.status}`);
    }
    const requests = (await response.json()) as MockOpenAiRequestSnapshot[];
    return requests.find(matches);
  });
}

describe("memory provenance through a real Gateway", () => {
  test(
    "carries restricted session memory across enabling a memory provider",
    { timeout: 180_000 },
    async ({ signal }) => {
      gateway = await startMemoryGateway(configureMemoryProof);
      restrictedClient = await connectGatewayClient({
        url: gateway.wsUrl,
        token: gateway.token,
        scopes: ["operator.write"],
      });

      const sessionKey = "agent:qa:memory-provenance-e2e";
      await sendAndWait({
        call: restrictedClient.request.bind(restrictedClient),
        sessionKey,
        message: `Remember this stored instruction: ${RESTRICTED_MARKER}`,
      });
      await sendAndWait({ call: gateway.call.bind(gateway), sessionKey, message: "/reset" });

      const memoryDir = path.join(gateway.workspaceDir, "memory");
      await waitFor(signal, "session-memory capture", async () => {
        const names = await fs.readdir(memoryDir).catch(() => []);
        for (const name of names) {
          if (!name.endsWith(".md")) {
            continue;
          }
          const content = await fs.readFile(path.join(memoryDir, name), "utf8");
          if (content.includes(RESTRICTED_MARKER)) {
            return name;
          }
        }
        return undefined;
      });

      const day = new Date().toISOString().slice(0, 10);
      const legacyPath = path.join(memoryDir, `${day}-legacy-owner.md`);
      await fs.writeFile(legacyPath, `- ${LEGACY_MARKER}\n`, "utf8");

      await gateway.restartAfterStateMutation(async ({ configPath }) => {
        const config = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
        ((config.plugins ??= {}).slots ??= {}).memory = "memory-core";
        await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      });

      const cursor = await requestCursor();

      const dreamingJob = (await gateway.call("cron.add", {
        name: "Memory provenance E2E",
        agentId: "qa",
        enabled: true,
        schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message: MEMORY_DREAMING_SYSTEM_EVENT_TEXT,
          lightContext: true,
        },
        delivery: { mode: "none" },
      })) as { id?: unknown };
      await runDreaming(signal, gateway, dreamingJob.id);
      const narrativeRequest = await waitForRequest(
        signal,
        cursor,
        (request) =>
          typeof request.allInputText === "string" && request.allInputText.includes(LEGACY_MARKER),
      );

      expect(narrativeRequest.allInputText).not.toContain(RESTRICTED_MARKER);
      expect(narrativeRequest.body?.tools ?? []).toEqual([]);
      expect(await fs.readFile(legacyPath, "utf8")).toContain(LEGACY_MARKER);
    },
  );

  test(
    "routes the explicit workspace owner into deep consolidation",
    { timeout: 180_000 },
    async ({ signal }) => {
      const activeGateway = await startMemoryGateway(configureExplicitOwnerProof, "mock-openai", [
        "qa",
        "researcher",
      ]);
      const memoryFileName = `${new Date().toISOString().slice(0, 10)}-explicit-owner.md`;
      const memoryPath = path.join(activeGateway.workspaceDir, "memory", memoryFileName);

      await activeGateway.restartAfterStateMutation(async () => {
        await fs.mkdir(path.dirname(memoryPath), { recursive: true });
        await fs.writeFile(
          memoryPath,
          `Hidden QA fact: the project codename is ORBIT-9. ${EXPLICIT_OWNER_MARKER}\n`,
          "utf8",
        );
        await activeGateway.runCli(["memory", "index", "--force", "--agent", "researcher"]);
      });

      await sendAndWait({
        call: activeGateway.call.bind(activeGateway),
        sessionKey: "agent:researcher:memory-explicit-owner-e2e",
        message:
          "Memory tools check: what is the hidden project codename stored only in memory? Use memory tools first.",
      });

      const recallEvent = await waitFor(signal, "explicit-owner recall tracking", async () => {
        const events = await readMemoryHostEventRecords({
          workspaceDir: activeGateway.workspaceDir,
          env: activeGateway.runtimeEnv,
        });
        return events.find(
          (event) =>
            event.type === "memory.recall.recorded" && event.query === "hidden project codename",
        );
      });
      expect(recallEvent).toMatchObject({ type: "memory.recall.recorded" });
      if (recallEvent.type !== "memory.recall.recorded") {
        throw new Error(`expected recorded recall, received ${JSON.stringify(recallEvent)}`);
      }
      expect(recallEvent.results.some((result) => result.path.endsWith(memoryFileName))).toBe(true);

      const cursor = await requestCursor();

      const dreamingJob = await waitFor(signal, "managed researcher dreaming cron", async () => {
        const cron = (await activeGateway.call("cron.list", {
          includeDisabled: true,
        })) as {
          jobs?: Array<{ id?: unknown; name?: unknown; agentId?: unknown }>;
        };
        return cron.jobs?.find((job) => job.name === "Memory Dreaming Promotion");
      });
      await runDreaming(signal, activeGateway, dreamingJob.id);
      // Consolidation sends source candidates as JSON; diary requests use prose.
      const consolidationRequest = await waitForRequest(
        signal,
        cursor,
        (request) =>
          request.prompt.startsWith("{") && request.prompt.includes(EXPLICIT_OWNER_MARKER),
      );
      expect(JSON.parse(consolidationRequest.prompt)).toMatchObject({
        currentMemory: expect.any(String),
        candidates: expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining(EXPLICIT_OWNER_MARKER),
            sourceRef: expect.stringContaining(`memory/${memoryFileName}#L`),
            provenance: expect.objectContaining({ originClass: "agent" }),
          }),
        ]),
      });
      expect(consolidationRequest.body.tools ?? []).toEqual([]);
      expect(activeGateway.logs()).not.toContain("AGENT_SELECTION_REQUIRED");

      const verdict = {
        ok: true,
        explicitOwner: "researcher",
        recallRecorded: recallEvent.resultCount > 0,
        consolidationReachedProvider: consolidationRequest.prompt.includes(EXPLICIT_OWNER_MARKER),
        ownerSelectionErrorAbsent: !activeGateway.logs().includes("AGENT_SELECTION_REQUIRED"),
      };
      expect(verdict.recallRecorded).toBe(true);
      console.log(`MEMORY_EXPLICIT_OWNER_CONSOLIDATION_PROOF=${JSON.stringify(verdict)}`);
    },
  );
});
