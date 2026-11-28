import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, describe, expect, it } from "vitest";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { isLiveTestEnabled, logLiveProgress } from "../agents/live-test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronJob } from "../cron/types.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { listKnownProviderAuthEnvVarNamesCore } from "../secrets/provider-env-vars.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import type { GatewayClient } from "./client.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";

const describeLive = isLiveTestEnabled() ? describe : describe.skip;
const PLUGIN_ID = "cron-snapshot-proof";
const MODEL_ID = "cron-snapshot-proof";
const SOURCE_KEY = "agent:probe:dashboard:cron-snapshot-proof";
const MARKER = "CRON_SNAPSHOT_PROOF";
type JobSnapshot = CronJob & { configRevision: string };
type Snapshot = { runId?: string; jobId?: string; jobConfigRevision?: string; trigger?: string };
type ProofStats = { calls: Array<{ before: Snapshot; after?: Snapshot }>; providerStarts: number };

// This release-only fixture proves cron persistence and hook delivery through a
// shipped Gateway. The registered hook handles every probe before inference;
// the loopback provider rejects any accidental model request instead of mocking a completion.
describeLive("cron snapshot revisions through an isolated Gateway", () => {
  it("retains the executing revision across a persisted edit, then projects the new run and omits non-cron facts", async ({
    signal,
  }) => {
    const entered = createDeferred();
    let heldResponse: ServerResponse | undefined;
    let providerRequests = 0;
    const receiver = await reserveTestPortListener({
      offsets: [0],
      signal,
      createListener: () =>
        createServer((request, response) => {
          request.resume();
          if (request.url === "/gate") {
            heldResponse = response;
            entered.resolve();
          } else {
            providerRequests += 1;
            response.writeHead(503).end("Unexpected model request in a handled-hook proof");
          }
        }),
    });
    const baseUrl = `http://127.0.0.1:${receiver.claim.port}`;
    let instance: Awaited<ReturnType<typeof createOpenClawTestInstance>> | undefined;
    let client: GatewayClient | undefined;
    let jobId: string | undefined;
    let finished = createDeferred<Record<string, unknown>>();
    await runQaGatewayFixture(
      async () => {
        instance = await createOpenClawTestInstance({
          name: "cron-hook-snapshot",
          signal,
          // Require the caller's exact candidate build; never build/install implicitly.
          entrypoint: ["dist/entry.js"],
          env: {
            ...Object.fromEntries(
              listKnownProviderAuthEnvVarNamesCore().map((name) => [name, undefined]),
            ),
            OPENAI_BASE_URL: undefined,
            OPENAI_API_BASE: undefined,
            OPENCLAW_AGENT_RUNTIME: undefined,
            OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
            OPENCLAW_SKIP_PROVIDERS: undefined,
            OPENCLAW_SKIP_CRON: "0",
            OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
            OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: undefined,
          },
        });
        const pluginPath = instance.state.path(PLUGIN_ID);
        await fs.mkdir(pluginPath, { recursive: true });
        await fs.writeFile(
          path.join(pluginPath, "package.json"),
          JSON.stringify({
            name: PLUGIN_ID,
            type: "commonjs",
            openclaw: { extensions: ["./index.cjs"] },
          }),
        );
        await fs.writeFile(
          path.join(pluginPath, "openclaw.plugin.json"),
          JSON.stringify({
            id: PLUGIN_ID,
            activation: { onStartup: true },
            configSchema: { type: "object", additionalProperties: false, properties: {} },
          }),
        );
        await fs.writeFile(
          path.join(pluginPath, "index.cjs"),
          `
const { fetchWithSsrFGuard, ssrfPolicyFromHttpBaseUrlAllowedOrigin } = require("openclaw/plugin-sdk/ssrf-runtime");
const base = ${JSON.stringify(baseUrl)};
const state = globalThis[Symbol.for("openclaw.test.cronSnapshotProof")] ??= { calls: [], providerStarts: 0 };
const snapshot = ctx => Object.fromEntries(["runId", "jobId", "jobConfigRevision", "trigger"].filter(key => ctx[key] !== undefined).map(key => [key, ctx[key]]));
module.exports = { id: ${JSON.stringify(PLUGIN_ID)}, register(api) {
  api.on("before_agent_reply", async (event, ctx) => {
    if (!event.cleanedBody.includes(${JSON.stringify(MARKER)})) return;
    const call = { before: snapshot(ctx) };
    state.calls.push(call);
    if (ctx.trigger === "cron" && state.calls.length === 1) {
      const { response, release } = await fetchWithSsrFGuard({ url: base + "/gate", policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(base) });
      try { await response.text(); } finally { await release(); }
    }
    call.after = snapshot(ctx);
    return { handled: true, reply: { text: "Snapshot recorded." } };
  }, { eligibleTriggers: ["cron", "user"] });
  api.on("model_call_started", () => { state.providerStarts++; });
  api.registerGatewayMethod("cronSnapshotProof.stats", ({ respond }) => respond(true, state), { scope: "operator.read" });
} };
`,
        );
        const config: OpenClawConfig = {
          gateway: {
            mode: "local",
            port: instance.port,
            auth: { mode: "token", token: instance.gatewayToken },
            controlUi: { enabled: false },
          },
          agents: {
            defaults: {
              workspace: instance.state.workspaceDir,
              skipBootstrap: true,
              model: { primary: `openai/${MODEL_ID}` },
              models: { [`openai/${MODEL_ID}`]: { agentRuntime: { id: "openclaw" } } },
              heartbeat: { every: "0m" },
              sandbox: { mode: "off" },
            },
            entries: { probe: { workspace: instance.state.workspaceDir } },
          },
          plugins: {
            load: { paths: [pluginPath] },
            entries: { [PLUGIN_ID]: { enabled: true, hooks: { allowConversationAccess: true } } },
          },
          cron: { enabled: true },
          tools: { allow: [] },
          models: {
            mode: "merge",
            providers: {
              openai: {
                api: "openai-responses",
                baseUrl: `${baseUrl}/v1`,
                apiKey: "synthetic-unused-key",
                models: [
                  {
                    id: MODEL_ID,
                    name: "Cron snapshot proof",
                    reasoning: false,
                    input: ["text"],
                    contextWindow: 32_000,
                    maxTokens: 1_024,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  },
                ],
              },
            },
          },
        };
        await instance.state.writeConfig(config);
        await instance.startGateway();
        client = await connectGatewayClient({
          url: instance.url,
          token: instance.gatewayToken,
          clientName: GATEWAY_CLIENT_NAMES.TEST,
          mode: GATEWAY_CLIENT_MODES.BACKEND,
          role: "operator",
          scopes: ["operator.admin", "operator.read", "operator.write"],
          deviceIdentity: loadOrCreateDeviceIdentity({
            path: instance.state.path("proof-client", "client", "credentials.sqlite"),
          }),
          onEvent: (event) => {
            if (
              event.event === "cron" &&
              isRecord(event.payload) &&
              event.payload.jobId === jobId &&
              event.payload.action === "finished"
            ) {
              finished.resolve(event.payload);
            }
          },
          signal,
        });
        await client.request("sessions.create", { key: SOURCE_KEY, agentId: "probe" });
        const original = await client.request<JobSnapshot>("cron.add", {
          agentId: "probe",
          name: "Cron snapshot before edit",
          enabled: false,
          schedule: { kind: "every", everyMs: 86_400_000 },
          sessionTarget: "current",
          sessionKey: SOURCE_KEY,
          wakeMode: "next-heartbeat",
          payload: {
            kind: "agentTurn",
            message: MARKER,
            model: `openai/${MODEL_ID}`,
            toolsAllow: [],
          },
          delivery: { mode: "none" },
        });
        jobId = original.id;
        assert(original.configRevision);
        const queued = await client.request<{ ok: boolean; enqueued: boolean }>("cron.run", {
          id: jobId,
          mode: "force",
        });
        expect(queued).toMatchObject({ ok: true, enqueued: true });
        await withinTest(
          awaitGateBeforeSettlement(
            entered.promise,
            finished.promise,
            "The first cron run settled before the registered preparation hook",
          ),
          signal,
        );
        const firstStats = await client.request<ProofStats>("cronSnapshotProof.stats", {});
        expect(firstStats.calls).toHaveLength(1);
        expect(firstStats.calls[0]?.before).toMatchObject({
          trigger: "cron",
          jobId,
          jobConfigRevision: original.configRevision,
        });
        const edited = await client.request<JobSnapshot>("cron.update", {
          id: jobId,
          expectedConfigRevision: original.configRevision,
          patch: { description: "Definition edited while its original hook is awaiting I/O" },
        });
        expect(edited.configRevision).not.toBe(original.configRevision);
        const persisted = await client.request<JobSnapshot>("cron.get", { id: jobId });
        expect(persisted.configRevision).toBe(edited.configRevision);
        expect(persisted.description).toBe(
          "Definition edited while its original hook is awaiting I/O",
        );
        assert(heldResponse);
        heldResponse.end("continue");
        expect(await withinTest(finished.promise, signal)).toMatchObject({
          status: "ok",
          completionStatus: "succeeded",
        });
        const afterEdit = await client.request<ProofStats>("cronSnapshotProof.stats", {});
        expect(afterEdit.calls[0]?.after).toEqual(afterEdit.calls[0]?.before);
        finished = createDeferred<Record<string, unknown>>();
        expect(await client.request("cron.run", { id: jobId, mode: "force" })).toMatchObject({
          ok: true,
          enqueued: true,
        });
        expect(await withinTest(finished.promise, signal)).toMatchObject({
          status: "ok",
          completionStatus: "succeeded",
        });
        const secondStats = await client.request<ProofStats>("cronSnapshotProof.stats", {});
        expect(secondStats.calls).toHaveLength(2);
        expect(secondStats.calls[1]?.before).toMatchObject({
          trigger: "cron",
          jobId,
          jobConfigRevision: edited.configRevision,
        });
        expect(secondStats.calls[1]?.before.runId).not.toBe(secondStats.calls[0]?.before.runId);
        const accepted = await client.request<{ runId: string; status: string }>("agent", {
          agentId: "probe",
          sessionKey: SOURCE_KEY,
          message: `${MARKER} normal turn`,
          deliver: false,
          idempotencyKey: randomUUID(),
        });
        expect(accepted.status).toBe("accepted");
        expect(
          await client.request("agent.wait", { runId: accepted.runId, timeoutMs: 60_000 }),
        ).toMatchObject({ status: "ok" });
        const finalStats = await client.request<ProofStats>("cronSnapshotProof.stats", {});
        expect(finalStats.calls).toHaveLength(3);
        expect(finalStats.calls[2]?.before).toMatchObject({ trigger: "user" });
        expect(finalStats.calls[2]?.before).not.toHaveProperty("jobConfigRevision");
        expect(finalStats.calls[2]?.before).not.toHaveProperty("jobId");
        expect(finalStats.providerStarts).toBe(0);
        expect(providerRequests).toBe(0);
        logLiveProgress(
          JSON.stringify({
            proof: "cron-hook-snapshot",
            activeRevisionRetained: true,
            persistedEditReadBack: true,
            nextRunUsesEditedRevision: true,
            nonCronOmitted: true,
            providerStarts: finalStats.providerStarts,
            providerRequests,
          }),
        );
      },
      async () => {
        heldResponse?.end();
        await client?.stopAndWait();
      },
      () => instance?.cleanup(),
      async () => {
        receiver.listener.closeAllConnections();
        await receiver.releaseListener();
      },
      () => receiver.claim.release(),
    );
  }, 180_000);
});
