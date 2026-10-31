import { appendFileSync, mkdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccountOwnedScheduledJob } from "../../test/helpers/cron/account-owned-scheduled-job.js";
import { installScheduledMessageReadRuntime } from "../../test/helpers/cron/scoped-acceptance-runtime.js";
import {
  closeHttpServer,
  listenLoopback,
  respondJson,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { createScheduledMessageReadModel } from "../../test/helpers/scheduled-message-read-model.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import { refreshPreparedModelRuntimeSnapshots } from "../agents/prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
  setRuntimeConfigSnapshot,
} from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadCronStore, resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import type { CronJobCreate } from "../cron/types.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "../gateway/mcp-http.js";
import { getActiveMcpLoopbackRuntime } from "../gateway/mcp-http.loopback-runtime.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../gateway/test-helpers.e2e.js";
import { acquireGatewayE2ePortBlock } from "../gateway/test-helpers.listener.js";
import { buildMockOpenAiResponsesProvider } from "../gateway/test-openai-responses-model.js";
import { buildAgentPeerSessionKey } from "../routing/session-key.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";

// Attached devices are outside these scheduled message journeys.
vi.mock("../agents/node-exec-availability.js", () => ({
  loadNodeExecAvailability: async () => ({ cacheKey: "no-nodes", isAvailable: () => false }),
}));

const channelId = "100000000000000003";
const guildId = "100000000000000001";
const messageId = "100000000000000020";
const providerMessage = "A synthetic message read by the scheduled turn.";
const embeddedModelId = "scheduled-message-read-fixture";
const modelToken = "synthetic-scheduled-model-token";
const nativeRequesterId = "100000000000000009";
const channelPath = `/api/v10/channels/${channelId}`;
const channelInfo = { id: channelId, guild_id: guildId, type: 0, name: "scheduled-read" };
const discordMessage = {
  id: messageId,
  channel_id: channelId,
  content: providerMessage,
  author: { id: nativeRequesterId, username: "synthetic", discriminator: "0" },
  timestamp: "2026-09-16T09:00:00.000Z",
  type: 0,
  attachments: [],
  embeds: [],
};
const discordRequest = (method: string, suffix = "") => ({
  method,
  path: `${channelPath}${suffix}`,
  authorizationMatches: true,
});
const waitFor = <T>(promise: PromiseLike<T>, timeout = 180_000) =>
  withTestTimeout(promise, timeout, "Scheduled message fixture timed out");

describe("scheduled message actions", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  async function runScenario(mode: "success" | "scoped-removed" | "active-revocation") {
    const evidenceDir = process.env.ACCEPTANCE_EVIDENCE_DIR;
    if (evidenceDir) {
      mkdirSync(evidenceDir, { recursive: true });
    }
    const trace: Array<Record<string, unknown>> = [];
    const record = (entry: Record<string, unknown>) => {
      trace.push(entry);
      if (evidenceDir) {
        appendFileSync(evidenceDir + "/" + mode + "-trace.jsonl", JSON.stringify(entry) + "\n");
      }
    };
    record({ kind: "fixture-start", at: Date.now() });
    const heldRead = { entered: createDeferred(), release: createDeferred() };
    const creatorAccountId = "work";
    const creatorSessionKey = buildAgentPeerSessionKey({
      agentId: "main",
      channel: "discord",
      accountId: creatorAccountId,
      peerKind: "channel",
      peerId: channelId,
    });
    const accountOwner = { sessionKey: creatorSessionKey, accountId: creatorAccountId };
    const accountPolicy = {
      version: 1,
      mode: "account",
      ownerSessionKey: creatorSessionKey,
      ownerAccountId: creatorAccountId,
    };
    const discordAccount = (token: string, read: boolean) => ({
      token,
      actions: { messages: read, channelInfo: !read },
    });
    const expectedProviderToken = "synthetic-creator-discord-token";
    const actionParams = {
      action: "read",
      channel: "discord",
      target: `channel:${channelId}`,
      limit: 1,
    };
    const expectedResult = {
      ok: true,
      channelId,
      messages: [{ id: messageId, channel_id: channelId, content: providerMessage }],
    };
    const assertAccountToolSchema = (schema: unknown) => {
      const properties = isRecord(schema) ? schema.properties : undefined;
      const actionSchema = isRecord(properties) ? properties.action : undefined;
      const actions = isRecord(actionSchema) ? actionSchema.enum : undefined;
      expect(actions).toContain("read");
      expect(actions).not.toContain("channel-info");
    };
    const embeddedModel = createScheduledMessageReadModel({
      modelId: embeddedModelId,
      apiKey: modelToken,
      actionParams,
      assertToolResult: (text) => record({ kind: "tool-result", at: Date.now(), text }),
      assertToolSchema: assertAccountToolSchema,
    });
    const isolatedHome = expectDefined(process.env.OPENCLAW_TEST_HOME, "isolated test HOME");
    const root = tempDirs.make("scheduled-message-read-", isolatedHome);
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const configPath = path.join(root, "openclaw.json");
    const cleanup: Array<() => void | Promise<void>> = [];
    const requests: Array<{ method: string; path: string; authorizationMatches: boolean }> = [];
    const providerErrors: unknown[] = [];
    const providerWork = new Set<Promise<void>>();
    await runQaGatewayFixture(
      async () => {
        await mkdir(workspaceDir, { recursive: true });
        // Minimal mode suppresses initial channel startup; the skip flags would also
        // remove channel credentials from the published runtime config.
        for (const [key, value] of Object.entries({
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_AGENT_DIR: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CHANNELS: undefined,
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_GATEWAY_URL: undefined,
          OPENCLAW_GATEWAY_TOKEN: undefined,
        })) {
          vi.stubEnv(key, value);
        }
        const gatewayPortClaim = await acquireGatewayE2ePortBlock();
        const gatewayPort = gatewayPortClaim.port;
        // Released here until Gateway startup owns the claim.
        let unstartedGatewayPortClaim: typeof gatewayPortClaim | undefined = gatewayPortClaim;
        cleanup.push(() => unstartedGatewayPortClaim?.release());
        const gatewayToken = "synthetic-scheduled-read-gateway-token";
        for (const key of [
          "HTTP_PROXY",
          "HTTPS_PROXY",
          "ALL_PROXY",
          "http_proxy",
          "https_proxy",
          "all_proxy",
        ]) {
          vi.stubEnv(key, undefined);
        }
        cleanup.push(() => clearRuntimeConfigSnapshot());
        cleanup.push(() => closeOpenClawStateDatabaseForTest());
        cleanup.push(() => closeOpenClawStateDatabaseAsync());

        const provider = createServer((req, res) => {
          const work = (async () => {
            const url = new URL(req.url ?? "/", "http://fixture.invalid");
            if (req.method === "POST" && url.pathname === "/v1/responses") {
              record({ kind: "model-request", at: Date.now() });
              await embeddedModel.respond(req, res);
              return;
            }
            const authorizationMatches =
              req.headers.authorization === `Bot ${expectedProviderToken}`;
            requests.push({ method: req.method ?? "", path: url.pathname, authorizationMatches });
            record({ kind: "tool-http", path: url.pathname, at: Date.now() });
            expect(authorizationMatches, "Discord fixture authorization matches").toBe(true);
            expect(req.method).toBe("GET");
            const body: unknown =
              url.pathname === channelPath
                ? channelInfo
                : url.pathname === `${channelPath}/messages`
                  ? [discordMessage]
                  : undefined;
            if (body === undefined) {
              throw new Error(`Unexpected provider request: ${req.method} ${url.pathname}`);
            }
            if (mode === "active-revocation" && url.pathname === channelPath) {
              record({ kind: "pre-read-barrier", at: Date.now() });
              heldRead.entered.resolve();
              await heldRead.release.promise;
              record({ kind: "pre-read-released", at: Date.now() });
            }
            respondJson(res, body);
          })().catch((error: unknown) => {
            providerErrors.push(error);
            record({ kind: "provider-error", at: Date.now(), error: String(error) });
            res.writeHead(500).end();
          });
          providerWork.add(work);
          void work.finally(() => providerWork.delete(work));
        });
        cleanup.push(async () => {
          if (provider.listening) {
            await closeHttpServer(provider);
          }
          await Promise.all(providerWork);
        });
        const providerOrigin = await listenLoopback(provider);
        const embedded = buildMockOpenAiResponsesProvider(`${providerOrigin}/v1`, embeddedModelId);
        const inferenceProvider = embedded.providerId;
        const inferenceProfileId = `${inferenceProvider}:scheduled-message-read`;
        const cfg: OpenClawConfig = {
          gateway: {
            mode: "local",
            port: gatewayPort,
            auth: { mode: "token", token: gatewayToken },
            controlUi: { enabled: false },
          },
          agents: {
            ownership: "explicit",
            entries: { main: {} },
            defaults: {
              workspace: workspaceDir,
              skipBootstrap: true,
              timeoutSeconds: 120,
              model: { primary: embedded.modelRef, fallbacks: [] },
              models: {
                [embedded.modelRef]: {
                  agentRuntime: { id: "openclaw" },
                  params: { transport: "sse", openaiWsWarmup: false },
                },
              },
              thinkingDefault: "off",
            },
          },
          models: {
            providers: {
              [embedded.providerId]: {
                ...embedded.config,
                apiKey: modelToken,
                request: { allowPrivateNetwork: true },
              },
            },
          },
          auth: {
            profiles: { [inferenceProfileId]: { provider: inferenceProvider, mode: "api_key" } },
            order: { [inferenceProvider]: [inferenceProfileId] },
          },
          tools: {
            // The scripted provider asserts the direct message schema and scheduled authority.
            toolSearch: false,
            allow: ["message", "automations"],
          },
          plugins: { allow: ["discord"], slots: { memory: "none" } },
          channels: {
            discord: {
              enabled: true,
              // Advancing the grant clock must not start an unrelated Discord transport.
              healthMonitor: { enabled: false },
              defaultAccount: "other",
              accounts: {
                work: discordAccount(expectedProviderToken, true),
                other: discordAccount("synthetic-other-discord-token", false),
              },
              groupPolicy: "allowlist",
              guilds: { [guildId]: { channels: { "*": { enabled: true } } } },
            },
          },
          cron: { enabled: false },
        };
        await writeFile(configPath, JSON.stringify(cfg));
        setRuntimeConfigSnapshot(cfg, cfg);
        await persistAuthProfileBatch({
          profiles: [
            {
              profileId: inferenceProfileId,
              credential: { type: "api_key", provider: inferenceProvider, key: modelToken },
            },
          ],
        });
        vi.stubEnv("DISCORD_API_URL", `${providerOrigin}/api/v10`);
        await ensureMcpLoopbackServer();
        cleanup.push(() => closeMcpLoopbackServer());
        const mcpRuntime = expectDefined(getActiveMcpLoopbackRuntime(), "task-owned MCP runtime");
        const mcpOrigin = `http://127.0.0.1:${mcpRuntime.port}`;
        const realFetch = globalThis.fetch.bind(globalThis);
        vi.stubGlobal(
          "fetch",
          vi.fn<typeof fetch>(async (input, init) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (
              url.origin !== providerOrigin &&
              url.origin !== mcpOrigin &&
              url.origin !== `http://127.0.0.1:${gatewayPort}`
            ) {
              throw new Error(`Unexpected fixture network destination: ${url.origin}`);
            }
            return await realFetch(input, init);
          }),
        );

        record({ kind: "registry-install-start", at: Date.now() });
        const registryFixture = await installScheduledMessageReadRuntime({
          cfg,
          cleanup,
        });
        cleanup.push(() => resetPreparedModelRuntimeSnapshotsForTest());
        const finished = createDeferred<Record<string, unknown>>();
        const scheduledJob: { id?: string } = {};
        unstartedGatewayPortClaim = undefined;
        record({ kind: "gateway-start", at: Date.now() });
        const gateway = await startGatewayWithClient({
          portClaim: gatewayPortClaim,
          cfg,
          configPath,
          token: gatewayToken,
          scopes: ["operator.admin"],
          onEvent: (event) => {
            if (
              event.event === "cron" &&
              isRecord(event.payload) &&
              event.payload.action === "finished" &&
              event.payload.jobId === scheduledJob.id
            ) {
              finished.resolve(event.payload);
            }
          },
        });
        cleanup.push(async () => {
          await runQaGatewayFixture(
            () => disconnectGatewayClient(gateway.client),
            () => gateway.server.close({ reason: "scheduled read fixture complete" }),
          );
        });
        await gateway.server.startupSettled;
        record({ kind: "gateway-ready", at: Date.now() });
        await refreshPreparedModelRuntimeSnapshots(getRuntimeConfig(), {
          gatewayLifecycle: true,
          catalogMode: "static",
        });
        record({ kind: "prepared-runtime-ready", at: Date.now() });
        const runtimeConfig = getRuntimeConfig();
        const params = {
          name: "Scoped scheduled Discord read",
          agentId: "main",
          enabled: true,
          schedule: { kind: "every", everyMs: 86_400_000 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: {
            kind: "agentTurn",
            message: `Read Discord channel ${channelId} using message without an accountId argument.`,
            toolsAllow: ["message"],
          },
          delivery: { mode: "none", channel: "discord", accountId: "other" },
        } satisfies CronJobCreate;
        const created = await createAccountOwnedScheduledJob({
          cfg: runtimeConfig,
          gatewayPort,
          agentId: "main",
          accountId: creatorAccountId,
          sessionKey: creatorSessionKey,
          model: { provider: embedded.providerId, model: embedded.modelId },
          job: params,
        });
        record({ kind: "job-created", at: Date.now() });
        scheduledJob.id = created.id;
        const storePath = resolveCronJobsStorePathFromConfig(getRuntimeConfig());
        const job = expectDefined(
          (await loadCronStore(storePath)).jobs.find((entry) => entry.id === created.id),
          "persisted scheduled job",
        );
        expect(job.inferenceBinding).toMatchObject({
          version: 1,
          provider: inferenceProvider,
          profileId: inferenceProfileId,
        });
        expect(job.owner).toEqual({ agentId: "main", ...accountOwner });
        expect(job.scheduledToolPolicy).toEqual(accountPolicy);
        expect(job.toolsAllowProvenance).toEqual({
          version: 1,
          source: "final-executable-surface",
          callerOrigin: { kind: "local" },
        });
        expect(job.delivery).toMatchObject({
          mode: "none",
          channel: "discord",
          accountId: "other",
        });
        expect(job.payload.toolsAllow).toEqual(["message"]);
        const registryFacts = registryFixture.select(
          mode === "scoped-removed" ? "scoped-removed" : "both-present",
        );
        record({ kind: "native-registry-authority", at: Date.now(), ...registryFacts });
        record({ kind: "scheduler-dispatch", at: Date.now(), mode });
        expect(
          await gateway.client.request("cron.run", { id: job.id, mode: "force" }),
        ).toMatchObject({ ok: true, enqueued: true });
        if (mode === "active-revocation") {
          try {
            await waitFor(
              Promise.race([
                heldRead.entered.promise,
                finished.promise.then((c) => {
                  throw new Error("Completed before read barrier: " + JSON.stringify(c));
                }),
              ]),
            );
            record({ kind: "revoke-requested", at: Date.now() });
            expect(
              await gateway.client.request("cron.update", {
                id: job.id,
                patch: { enabled: false },
              }),
            ).toMatchObject({ id: job.id, enabled: false });
            record({ kind: "revoked", at: Date.now() });
          } finally {
            heldRead.release.resolve();
          }
        }
        const completion = await waitFor(finished.promise);
        record({
          kind: "finished",
          at: Date.now(),
          status: completion.status,
          error: completion.error,
        });
        if (mode !== "success") {
          expect(requests.filter((r) => r.path.endsWith("/messages"))).toEqual([]);
          if (mode === "scoped-removed") {
            expect(requests).toEqual([]);
            expect(embeddedModel.observation.requests).toBe(0);
            expect(completion).toMatchObject({ status: "error" });
            expect(String(completion.error)).toContain('Scheduled account "work" is unavailable');
          } else {
            expect(completion).toMatchObject({
              status: "error",
              error: "Cron job disabled by operator.",
            });
            expect(embeddedModel.observation.requests).toBe(1);
            expect(requests).toEqual([discordRequest("GET")]);
            const kinds = trace.map((entry) => entry.kind);
            const barrier = kinds.indexOf("pre-read-barrier");
            const revoked = kinds.indexOf("revoked");
            const released = kinds.indexOf("pre-read-released");
            expect(barrier).toBeGreaterThanOrEqual(0);
            expect(revoked).toBeGreaterThan(barrier);
            expect(released).toBeGreaterThan(revoked);
          }
          if (evidenceDir) {
            await writeFile(
              evidenceDir + "/" + mode + ".json",
              JSON.stringify(
                { mode, trace, requests, model: embeddedModel.observation, completion },
                null,
                2,
              ),
            );
          }
          expect(providerErrors).toEqual([]);
          return;
        }
        expect(completion).toMatchObject({ status: "ok" });
        expect(embeddedModel.observation).toMatchObject({
          requests: 2,
          messageToolAdvertised: true,
        });
        expect(
          JSON.parse(expectDefined(embeddedModel.observation.toolOutput, "scheduled tool result")),
        ).toMatchObject(expectedResult);
        expect(requests).toContainEqual(discordRequest("GET"));
        expect(requests).toContainEqual(discordRequest("GET", "/messages"));
        expect(providerErrors).toEqual([]);
        if (evidenceDir) {
          await writeFile(
            evidenceDir + "/" + mode + ".json",
            JSON.stringify(
              { mode, trace, requests, model: embeddedModel.observation, completion },
              null,
              2,
            ),
          );
        }
      },
      // Release provider responses before Gateway shutdown waits for pending writes.
      () => {
        heldRead.release.resolve();
      },
      () => runQaGatewayFixture(async () => {}, ...cleanup.toReversed()),
      () => vi.restoreAllMocks(),
      () => vi.unstubAllGlobals(),
      () => vi.unstubAllEnvs(),
    );
  }
  it.each(["success", "scoped-removed", "active-revocation"] as const)(
    "real scoped scheduled %s",
    { timeout: 300_000 },
    runScenario,
  );
});
