import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { buildQaGatewayConfig } from "../../../../extensions/qa-lab/test-api.js";
import type {
  SessionGitHubPublicationResult,
  SessionGitHubReadinessResult,
} from "../../../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/version.js";
import { SUPERVISOR_HINT_ENV_VARS } from "../../../../src/infra/supervisor-markers.js";
import { readBuildIdFromBuildInfoForModuleUrl } from "../../../../src/version.js";
import { GATEWAY_RESTART_TEST_KILL_MS } from "../../../helpers/gateway-restart-budget.js";
import {
  acquireGatewayTestWebSocket,
  closeGatewayTestWebSocket,
} from "../../../helpers/gateway-websocket.js";
import { createOpenClawTestInstance } from "../../../helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import {
  connectWireClient,
  createPairedNodeWorkerHost,
  createPublishedWireWorkspace,
  createWireWorkspaceSettlementWaiter,
  closeWireServer,
  type PairedNodeWorkerHost,
} from "./paired-node-worker-wire-fixture.js";
import { gitWrapper, request } from "./test-support/managed-setup-fixtures.test-support.js";
import { publicationProcessFixture } from "./test-support/publication-process-fixture.js";
import { publicationProcessProvider } from "./test-support/publication-process-provider.js";
import { publicationProcessReceipt } from "./test-support/publication-process-receipt.js";
import {
  SETUP_PROOF_ACTOR,
  SETUP_PROOF_GITHUB_TOKEN,
  SETUP_PROOF_REMOTE,
} from "./test-support/setup-repository-integration/api.js";

const scopes: Array<"operator.admin" | "operator.read" | "operator.write"> = [
  "operator.admin",
  "operator.read",
  "operator.write",
];
const PASSWORD = "synthetic-publication-process-controller";
const MODEL = "mock-openai/gpt-5.6-luna";

for (const scenario of ["allowed", "revoked"] as const) {
  it(
    "retains original publication across an owned Gateway OS-process restart: " + scenario,
    { timeout: 240_000 },
    async ({ signal }) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "publication-process-"));
      const published = await createPublishedWireWorkspace(root, [], { smartHttp: true });
      const github = await publicationProcessFixture(root, path.join(root, "repo.git"));
      const provider = await publicationProcessProvider();
      const address = published.server.address();
      assert(address && typeof address !== "string");
      const git = await gitWrapper(
        path.join(root, "bin"),
        "http://127.0.0.1:" + address.port + "/repo.git",
      );
      const preload = new URL("./worker-github-api-preload.mjs", import.meta.url);
      preload.searchParams.set("fixture", github.apiBaseUrl);
      const profile = "publication-process-" + scenario;
      const instance = await createOpenClawTestInstance({
        name: profile,
        signal,
        entrypoint: ["dist/index.js", "--profile", profile],
        gatewayCommandPrefix: [process.execPath, "--import", preload.href],
        gracefulShutdownTimeoutMs: GATEWAY_RESTART_TEST_KILL_MS,
        env: {
          OPENCLAW_PROFILE: profile,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_BUILD_PRIVATE_QA: "1",
          GH_TOKEN: SETUP_PROOF_GITHUB_TOKEN,
          GITHUB_TOKEN: undefined,
          NODE_EXTRA_CA_CERTS: github.cert,
          NO_PROXY: [process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(","),
          no_proxy: [process.env.no_proxy, "127.0.0.1", "localhost"].filter(Boolean).join(","),
          PATH: path.dirname(git) + path.delimiter + process.env.PATH,
          TMPDIR: root,
          XDG_CACHE_HOME: path.join(root, "cache"),
        },
      });
      for (const name of SUPERVISOR_HINT_ENV_VARS) {
        delete instance.env[name];
      }
      instance.env.OPENCLAW_GATEWAY_PORT = String(instance.port);
      const config = buildQaGatewayConfig({
        bind: "loopback",
        gatewayPort: instance.port,
        gatewayToken: instance.gatewayToken,
        workspaceDir: instance.state.workspaceDir,
        providerBaseUrl: provider.baseUrl + "/v1",
        providerMode: "mock-openai",
        primaryModel: MODEL,
        alternateModel: MODEL,
        enabledPluginIds: ["openai"],
        controlUiEnabled: false,
      });
      config.agents!.defaults!.models![MODEL]!.agentRuntime = { id: "openclaw" };
      config.tools = { ...config.tools, codeMode: false, exec: { mode: "full" } };
      config.nodeHost = { workerRuns: { enabled: true } };
      config.logging = { file: path.join(root, "gateway.log") };
      config.gateway = {
        ...config.gateway,
        repositoryIntegration: "setup-proof-repository",
        trustedProxies: ["127.0.0.1"],
        controlUi: { enabled: false, allowedOrigins: ["http://127.0.0.1:" + instance.port] },
        auth: {
          mode: "trusted-proxy",
          password: PASSWORD,
          identityScopes: { [SETUP_PROOF_ACTOR]: scopes },
          trustedProxy: {
            userHeader: "x-setup-email",
            allowUsers: [SETUP_PROOF_ACTOR],
            allowLoopback: true,
          },
        },
        roles: {
          default: "writer",
          definitions: {
            writer: { agents: ["qa"], scopes, sessions: { others: "none" } },
            revoked: { agents: [], scopes: [], sessions: { others: "none" } },
          },
        },
      };
      config.plugins = {
        ...config.plugins,
        enabled: true,
        allow: [...config.plugins!.allow!, "setup-proof-repository"],
        load: {
          paths: [
            fileURLToPath(new URL("./test-support/setup-repository-integration", import.meta.url)),
          ],
        },
        entries: {
          ...config.plugins!.entries,
          "setup-proof-repository": { enabled: true, config: { preparedCapacity: "repository" } },
        },
      };
      await instance.state.writeConfig(config);
      let writer: WebSocket | undefined;
      let operator: Awaited<ReturnType<typeof connectWireClient>> | undefined;
      let node: PairedNodeWorkerHost | undefined;
      const settlement = createWireWorkspaceSettlementWaiter();
      const key = "agent:qa:publication-process-" + scenario;
      const publication = {
        sessionKey: key,
        agentId: "qa",
        idempotencyKey: "process-restart-original",
        title: "Task-local publication restart proof",
        body: "Synthetic local transport only.",
        selection: { source: "shared" as const },
      };
      const connectWriter = async () => {
        writer = new WebSocket(instance.url, {
          headers: {
            "x-setup-email": SETUP_PROOF_ACTOR,
            "x-forwarded-for": "203.0.113.42",
            "x-forwarded-proto": "http",
            "x-forwarded-host": new URL(instance.url).host,
            origin: "http://127.0.0.1:" + instance.port,
          },
        });
        await acquireGatewayTestWebSocket(writer, 10_000);
        const buildId = readBuildIdFromBuildInfoForModuleUrl(
          new URL("../../../../dist/index.js", import.meta.url).href,
        );
        return await request(
          writer,
          "connect",
          {
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            client: {
              id: "openclaw-control-ui",
              version: "1",
              ...(buildId ? { buildId } : {}),
              platform: "test",
              mode: "webchat",
            },
            role: "operator",
            scopes,
          },
          signal,
        );
      };
      const rpc = async <T>(method: string, params: unknown): Promise<T> => {
        assert(writer);
        const response = await request(writer, method, params, signal);
        expect(response.ok, JSON.stringify(response.error)).toBe(true);
        return response.payload as T;
      };
      const gracefulStop = async () => {
        const child = instance.child;
        if (child && child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          assert(child.kill("SIGTERM"));
          expect(await exited).toEqual([0, null]);
        }
        await instance.stopGateway();
      };
      await runQaGatewayFixture(
        async () => {
          await instance.startGateway();
          const first = instance.child;
          assert(first?.pid);
          console.log("PUBLICATION_PROCESS_PID1", first.pid);
          const gateway = {
            wsUrl: instance.url,
            token: instance.gatewayToken,
            runtimeEnv: instance.env,
          };
          operator = await connectWireClient({
            gateway,
            role: "operator",
            password: PASSWORD,
            identity: null,
            onEvent: settlement.onEvent,
          });
          await operator.request("sessions.subscribe", {});
          node = await createPairedNodeWorkerHost({
            gateway,
            operator,
            password: PASSWORD,
            root: path.join(root, "node"),
            workspaceQuiescence: true,
            publicationIntegration: true,
            workerEnv: {
              TMPDIR: root,
              PATH: instance.env.PATH,
              GH_TOKEN: undefined,
              GITHUB_TOKEN: undefined,
            },
          });
          const hello = await connectWriter();
          expect(hello.ok, JSON.stringify(hello.error)).toBe(true);
          await rpc("sessions.create", {
            key,
            agentId: "qa",
            repository: { url: SETUP_PROOF_REMOTE, ref: "main" },
            permissionMode: "full",
          });
          const dispatched = await rpc("sessions.dispatch", {
            key,
            deviceId: node.identity.deviceId,
          });
          console.log("PUBLICATION_PROCESS_DISPATCH", JSON.stringify(dispatched));
          const runId = randomUUID();
          await rpc("chat.send", {
            sessionKey: key,
            message:
              "Write restart-proof.txt containing retained original publication, then finish.",
            deliver: false,
            idempotencyKey: runId,
          });
          expect(await operator.request("agent.wait", { runId, timeoutMs: 60_000 })).toMatchObject({
            status: "ok",
          });
          await settlement.wait(operator, key, signal);
          await node.waitForWorkersIdle();
          expect(provider.requests).toBeGreaterThan(0);
          // Public managed setup selects a synthetic per-agent publisher, not host gh credentials.
          const secretName = "github-setup-" + randomUUID().replaceAll("-", "");
          await operator.request("secrets.store.set", {
            name: secretName,
            kind: "secret",
            value: SETUP_PROOF_GITHUB_TOKEN,
          });
          const configured = await operator.request("tools.github.configure", {
            scope: "agent",
            agentId: "qa",
            mode: "managed",
            secretName,
          });
          expect(configured).toMatchObject({
            effective: {
              source: "agent-override",
              credentialState: "available",
              account: { login: "setup-fixture" },
            },
          });
          const accepted = await rpc<SessionGitHubPublicationResult>(
            "sessions.github.publish",
            publication,
          );
          const requestId = accepted.requestId;
          console.log("PUBLICATION_PROCESS_ACCEPTED", JSON.stringify(accepted));
          const observe = () =>
            operator!.request<SessionGitHubReadinessResult>("sessions.github.readiness", {
              sessionKey: key,
              agentId: "qa",
              requestId,
            });
          await vi.waitFor(
            async () =>
              expect(await observe()).toMatchObject({
                request: {
                  kind: "observed",
                  receipt: { requestId, status: "failed", code: "unavailable" },
                },
              }),
            { timeout: 60_000, interval: 100 },
          );
          const saved = await publicationProcessReceipt(instance.env, requestId);
          assert(saved?.checkpoint_digest);
          assert(saved.checkpoint_ref);
          expect(saved.source_head_commit).toBe(github.head);
          expect(github.effects.physicalCas).toBe(0);
          if (scenario === "revoked") {
            const users = await operator.request<{
              profiles: Array<{ id: string; emails: string[] }>;
            }>("users.list", {});
            const original = users.profiles.find((p) => p.emails.includes(SETUP_PROOF_ACTOR));
            assert(original);
            await operator.request("users.setRole", { profileId: original.id, role: "revoked" });
          }
          await closeGatewayTestWebSocket(writer!);
          writer = undefined;
          await node.disconnect();
          // Retain node supervisor, workspace and device owners while only Gateway PID1 ends.
          await gracefulStop();
          expect(() => process.kill(first.pid!, 0)).toThrow();
          console.log("PUBLICATION_PROCESS_EXTINCTION", first.pid);
          await instance.startGateway();
          const second = instance.child;
          assert(second?.pid);
          expect(second.pid).not.toBe(first.pid);
          console.log("PUBLICATION_PROCESS_PID2", second.pid);
          await vi.waitFor(() => operator!.request("health", {}), {
            timeout: 30_000,
            interval: 100,
          });
          await node.connect();
          await operator.request("sessions.subscribe", {});
          expect(await observe()).toMatchObject({
            request: { receipt: { requestId, status: "failed", code: "unavailable" } },
          });
          expect(await publicationProcessReceipt(instance.env, requestId)).toEqual(saved);
          github.recover();
          const before = { ...github.effects, frames: node.frames.length };
          const reopenedHello = await connectWriter();
          if (scenario === "revoked") {
            if (reopenedHello.ok) {
              const denied = await request(writer!, "sessions.github.publish", publication, signal);
              expect(denied.ok).toBe(false);
            }
            expect({ ...github.effects, frames: node.frames.length }).toEqual(before);
            expect(await publicationProcessReceipt(instance.env, requestId)).toEqual(saved);
          } else {
            expect(reopenedHello.ok, JSON.stringify(reopenedHello.error)).toBe(true);
            const reopened = await rpc<SessionGitHubPublicationResult>(
              "sessions.github.publish",
              publication,
            );
            expect(reopened.requestId).toBe(requestId);
            await vi.waitFor(
              async () =>
                expect(await observe()).toMatchObject({
                  request: { receipt: { requestId, status: "published" } },
                }),
              { timeout: 60_000, interval: 100 },
            );
            const final = await publicationProcessReceipt(instance.env, requestId);
            assert(final?.head_commit);
            expect(final).toMatchObject({
              request_id: saved.request_id,
              request_digest: saved.request_digest,
              checkpoint_ref: saved.checkpoint_ref,
              checkpoint_digest: saved.checkpoint_digest,
              source_head_commit: saved.source_head_commit,
              source_index_tree: saved.source_index_tree,
              workspace_tree: saved.workspace_tree,
              requester_authority_json: saved.requester_authority_json,
              status: "published",
            });
            expect(github.effects.physicalCas).toBe(1);
            expect(github.effects.pullRequests).toBe(1);
            expect(await github.git(["rev-parse", "refs/heads/" + final.branch])).toBe(
              final.head_commit,
            );
            expect(await github.git(["merge-base", github.head, final.head_commit])).toBe(
              github.head,
            );
            expect(await github.git(["show", final.head_commit + ":restart-proof.txt"])).toBe(
              "retained original publication",
            );
          }
          console.log(
            "PUBLICATION_PROCESS_PROOF",
            JSON.stringify({
              scenario,
              firstPid: first.pid,
              secondPid: second.pid,
              deviceId: node.identity.deviceId,
              requestId,
              checkpoint: saved.checkpoint_ref,
              digest: saved.checkpoint_digest,
              effects: github.effects,
              receipt: await observe(),
            }),
          );
        },
        () => writer && closeGatewayTestWebSocket(writer),
        () => {
          console.log("PUBLICATION_EXTERNAL_EFFECTS", JSON.stringify(github.effects));
        },
        () => node?.stop(),
        () => operator?.stopAndWait(),
        gracefulStop,
        () =>
          fs.writeFile(
            path.join(
              process.cwd(),
              ".openclaw/tmp/recovery-proof/process-proof/gateway-" + scenario + ".log",
            ),
            instance.logs(),
          ),
        () => instance.cleanup(),
        () => github.close(),
        () => provider.close(),
        () => closeWireServer(published.server),
        () => fs.rm(root, { recursive: true, force: true }),
      );
    },
  );
}
