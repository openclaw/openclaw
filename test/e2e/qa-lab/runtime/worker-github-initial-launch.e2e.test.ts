import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:https";
import os from "node:os";
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { Value } from "typebox/value";
import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { z } from "zod";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import {
  ResponseFrameSchema,
  type ResponseFrame,
} from "../../../../packages/gateway-protocol/src/schema/frames.js";
import { PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/version.js";
import { listDirectoryTreeStrict } from "../../../../src/infra/directory-walk.js";
import {
  NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
  NODE_WORKER_WORKSPACE_EXEC_COMMAND,
} from "../../../../src/infra/node-commands.js";
import { runCommandWithTimeout } from "../../../../src/process/exec.js";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import { readBuildIdFromBuildInfoForModuleUrl } from "../../../../src/version.js";
import { parseNodeWorkerLaunchInput } from "../../../../src/worker/node-supervisor-protocol.js";
import {
  NODE_WORKSPACE_QUIESCENCE_COMMAND,
  parseNodeWorkerWorkspaceExecInput,
} from "../../../../src/worker/node-workspace-protocol.js";
import {
  acquireGatewayTestWebSocket,
  closeGatewayTestWebSocket,
} from "../../../helpers/gateway-websocket.js";
import { withinTest } from "../../../helpers/promise.js";
import { runQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { startPairedNodeWorkerLifecycleProvider } from "./paired-node-worker-lifecycle-provider.js";
import {
  closeWireServer,
  connectWireClient,
  createPairedNodeWorkerHost,
  createPublishedWireWorkspace,
  createWireWorkspaceSettlementWaiter,
  startPairedNodeWorkerGateway,
  type PairedNodeWorkerHost,
  type WireGateway,
} from "./paired-node-worker-wire-fixture.js";

const TOKEN = "synthetic-initial-worker-github-token";
const LOCAL_PASSWORD = "synthetic-local-gateway-password";
const WRITER = "initial-writer@example.test";
const REMOTE = "https://github.com/example/initial-launch.git";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

async function command(argv: string[], cwd?: string) {
  const result = await runCommandWithTimeout(argv, { cwd, timeoutMs: 20_000 });
  if (result.code !== 0) {
    throw new Error(`Fixture command ${argv[0]} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function githubFixture(root: string) {
  const key = path.join(root, "github.key");
  const cert = path.join(root, "github.crt");
  await command([
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-days",
    "1",
  ]);
  let verified = 0;
  const server = createServer(
    { key: await fs.readFile(key), cert: await fs.readFile(cert) },
    (incoming, response) => {
      if (!incoming.headers.authorization?.endsWith(TOKEN)) {
        response.writeHead(401).end();
        return;
      }
      response.setHeader("Content-Type", "application/json");
      response.setHeader("x-oauth-scopes", "repo");
      if (incoming.url === "/user") {
        verified++;
        response.end(
          JSON.stringify({ id: 4242, login: "initial-fixture", type: "User", avatar_url: null }),
        );
      } else if (incoming.url?.startsWith("/repos/")) {
        response.end(
          JSON.stringify({
            id: 7,
            name: "initial-launch",
            full_name: "example/initial-launch",
            private: false,
            default_branch: "main",
            owner: { login: "example" },
            permissions: { pull: true, push: true, admin: true },
          }),
        );
      } else {
        response.writeHead(404).end();
      }
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    apiBaseUrl: `https://127.0.0.1:${address.port}`,
    cert,
    get verified() {
      return verified;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

async function request(
  ws: WebSocket,
  method: string,
  params: unknown,
  signal: AbortSignal,
): Promise<ResponseFrame> {
  const id = randomUUID();
  const pending = createDeferredCore<ResponseFrame>();
  const onMessage = (data: Parameters<typeof rawDataToString>[0]) => {
    const value: unknown = JSON.parse(rawDataToString(data));
    if (Value.Check(ResponseFrameSchema, value) && value.id === id) {
      pending.resolve(value);
    }
  };
  const abort = () => pending.reject(signal.reason);
  ws.on("message", onMessage);
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    ws.send(JSON.stringify({ type: "req", id, method, params }));
    return await pending.promise;
  } finally {
    ws.off("message", onMessage);
    signal.removeEventListener("abort", abort);
  }
}

async function profiles(root: string): Promise<string[]> {
  const files = await listDirectoryTreeStrict(root);
  return files
    .filter(
      (file) =>
        file.relativePath.includes("github-profiles") && file.relativePath.endsWith("hosts.yml"),
    )
    .map((file) => path.join(root, file.relativePath));
}

for (const scenario of [
  "allowed",
  "original-operator-revoked",
  "cancelled-before-successor",
] as const) {
  it.skipIf(process.platform !== "linux")(
    `shipped worker initial GitHub launch after request completion: ${scenario}`,
    { timeout: 240_000 },
    async ({ signal }) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-github-initial-"));
      const owner = createQaGatewayChild();
      const marker = `WIRE-GITHUB-${scenario.toUpperCase()}`;
      let provider: Awaited<ReturnType<typeof startPairedNodeWorkerLifecycleProvider>> | undefined;
      let github: Awaited<ReturnType<typeof githubFixture>> | undefined;
      let published: Awaited<ReturnType<typeof createPublishedWireWorkspace>> | undefined;
      let gateway: WireGateway | undefined;
      let operator: GatewayClient | undefined;
      let writer: WebSocket | undefined;
      let node: PairedNodeWorkerHost | undefined;
      const entered = createDeferredCore();
      const release = createDeferredCore();
      let hold = false;
      const settlement = createWireWorkspaceSettlementWaiter();
      await runQaGatewayFixture(
        async () => {
          const activeProvider = (provider = await startPairedNodeWorkerLifecycleProvider([
            marker,
          ]));
          const activeGitHub = (github = await githubFixture(root));
          const activeWorkspace = (published = await createPublishedWireWorkspace(root));
          await command([
            "git",
            "-C",
            activeWorkspace.source,
            "remote",
            "set-url",
            "origin",
            REMOTE,
          ]);
          const githubPreload = new URL("./worker-github-api-preload.mjs", import.meta.url);
          githubPreload.searchParams.set("fixture", activeGitHub.apiBaseUrl);
          gateway = await startPairedNodeWorkerGateway({
            owner,
            providerBaseUrl: activeProvider.baseUrl,
            fullAccess: true,
            controlUiEnabled: true,
            rpcPassword: LOCAL_PASSWORD,
            command: {
              executablePath: process.execPath,
              argsPrefix: ["--import", githubPreload.href, "dist/index.js"],
              cwd: process.cwd(),
              tempParentDir: root,
              usePackagedPlugins: false,
            },
            runtimeEnvPatch: {
              OPENCLAW_GATEWAY_TOKEN: undefined,
              GH_TOKEN: TOKEN,
              GITHUB_TOKEN: undefined,
              NODE_EXTRA_CA_CERTS: activeGitHub.cert,
            },
            mutateConfig: (config) => ({
              ...config,
              gateway: {
                ...config.gateway,
                trustedProxies: ["127.0.0.1"],
                controlUi: {
                  ...config.gateway?.controlUi,
                  allowedOrigins: [`http://127.0.0.1:${config.gateway?.port}`],
                },
                auth: {
                  mode: "trusted-proxy",
                  password: LOCAL_PASSWORD,
                  identityScopes: {
                    [WRITER]: ["operator.admin", "operator.read", "operator.write"],
                  },
                  trustedProxy: { userHeader: "x-initial-email", allowLoopback: true },
                },
                roles: {
                  default: "writer",
                  definitions: {
                    writer: {
                      agents: ["qa"],
                      scopes: ["operator.admin", "operator.read", "operator.write"],
                      sessions: { others: "write" },
                    },
                    revoked: { agents: [], scopes: [], sessions: { others: "none" } },
                  },
                },
              },
            }),
          });
          operator = await connectWireClient({
            gateway,
            role: "operator",
            password: LOCAL_PASSWORD,
            identity: null,
            onEvent: settlement.onEvent,
          });
          await operator.request("sessions.subscribe", {});
          const nodeRoot = path.join(root, "paired-node");
          const workerTmp = path.join(root, "worker-tmp");
          await fs.mkdir(workerTmp);
          node = await createPairedNodeWorkerHost({
            gateway,
            operator,
            root: nodeRoot,
            password: LOCAL_PASSWORD,
            workspaceQuiescence: true,
            workerEnv: {
              TMPDIR: workerTmp,
              GH_TOKEN: undefined,
              GITHUB_TOKEN: undefined,
              GH_ENTERPRISE_TOKEN: undefined,
              GITHUB_ENTERPRISE_TOKEN: undefined,
            },
            beforeInvoke: async (frame) => {
              if (!hold || frame.command !== NODE_WORKER_WORKSPACE_EXEC_COMMAND) {
                return;
              }
              const input = parseNodeWorkerWorkspaceExecInput(frame.paramsJSON);
              if (
                input.argv[0] === NODE_WORKSPACE_QUIESCENCE_COMMAND &&
                input.quiescence?.action === "acquire"
              ) {
                entered.resolve();
                await release.promise;
              }
            },
          });
          await node.connect();
          const buildId = readBuildIdFromBuildInfoForModuleUrl(
            new URL("../../../../dist/index.js", import.meta.url).href,
          );
          assert(buildId);
          writer = new WebSocket(gateway.wsUrl, {
            headers: {
              "x-initial-email": WRITER,
              "x-forwarded-for": "203.0.113.42",
              "x-forwarded-proto": "http",
              "x-forwarded-host": new URL(gateway.wsUrl).host,
              origin: gateway.wsUrl.replace(/^ws:/, "http:"),
            },
          });
          await acquireGatewayTestWebSocket(writer, 10_000);
          const hello = await request(
            writer,
            "connect",
            {
              minProtocol: PROTOCOL_VERSION,
              maxProtocol: PROTOCOL_VERSION,
              client: {
                id: "openclaw-control-ui",
                version: "1",
                buildId,
                platform: "test",
                mode: "webchat",
              },
              role: "operator",
              scopes: ["operator.admin", "operator.read", "operator.write"],
            },
            signal,
          );
          expect(hello.ok, JSON.stringify(hello.error)).toBe(true);
          const key = `agent:qa:initial-github-${scenario}`;
          const created = await request(
            writer,
            "sessions.create",
            {
              key,
              agentId: "qa",
              permissionMode: "full",
              worktree: true,
              worktreeName: `initial-github-${scenario}`,
              worktreeBaseRef: "main",
              cwd: activeWorkspace.source,
            },
            signal,
          );
          expect(created.ok, JSON.stringify(created.error)).toBe(true);
          const dispatched = await gateway.call("sessions.dispatch", {
            key,
            deviceId: node.identity.deviceId,
          });
          expect(dispatched).toMatchObject({ placement: { state: "active" } });
          const send = async (message: string) => {
            const runId = randomUUID();
            const ack = await request(
              writer!,
              "chat.send",
              {
                sessionKey: key,
                message: `Reply exactly: ${message}`,
                deliver: false,
                idempotencyKey: runId,
              },
              signal,
            );
            expect(ack.ok, JSON.stringify(ack.error)).toBe(true);
            expect(ack.payload).toMatchObject({ runId, status: "started" });
            return runId;
          };
          const warmup = await send("WIRE-GITHUB-WARMUP");
          expect(
            await operator.request("agent.wait", { runId: warmup, timeoutMs: 60_000 }),
          ).toMatchObject({ status: "ok" });
          await settlement.wait(operator, key, signal);
          expect(activeGitHub.verified).toBeGreaterThan(0);
          await vi.waitFor(async () => expect((await profiles(workerTmp)).length).toBe(0), {
            timeout: 10_000,
          });
          hold = true;
          const runId = await send(marker);
          await withinTest(entered.promise, signal);
          const launches = (targetRunId = runId) =>
            node!.frames
              .filter((frame) => frame.command === NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND)
              .map((frame) => parseNodeWorkerLaunchInput(frame.paramsJSON))
              .filter((frame) => frame.descriptor.assignment.runId === targetRunId);
          expect(launches().length).toBe(0);
          if (scenario === "original-operator-revoked") {
            const listed = z
              .object({
                profiles: z.array(z.object({ id: z.string(), emails: z.array(z.string()) })),
              })
              .parse(await operator.request("users.list", {}));
            const profile = listed.profiles.find((item) => item.emails.includes(WRITER));
            assert(profile);
            await operator.request("users.setRole", { profileId: profile.id, role: "revoked" });
          } else if (scenario === "cancelled-before-successor") {
            const aborted = await request(writer, "chat.abort", { sessionKey: key, runId }, signal);
            expect(aborted.ok, JSON.stringify(aborted.error)).toBe(true);
          }
          release.resolve();
          if (scenario === "allowed") {
            await withinTest(activeProvider.waitForHeld(marker), signal);
            const observed = launches();
            expect(observed.length).toBe(1);
            const binding = observed[0]?.descriptor.assignment.github;
            assert(binding);
            expect(digest(binding.token)).toBe(digest(TOKEN));
            const installed = await profiles(workerTmp);
            expect(installed.length).toBe(1);
            expect((await fs.readFile(installed[0]!, "utf8")).includes(TOKEN)).toBe(true);
            activeProvider.release(marker);
            expect(
              await operator.request("agent.wait", { runId, timeoutMs: 60_000 }),
            ).toMatchObject({
              status: "ok",
            });
          } else {
            const result = z
              .object({ status: z.string() })
              .parse(await operator.request("agent.wait", { runId, timeoutMs: 60_000 }));
            expect(result.status).not.toBe("timeout");
            expect(launches().length).toBe(0);
            expect(activeProvider.hasHeld(marker)).toBe(false);
          }
          await settlement.wait(operator, key, signal);
          await node.waitForWorkersIdle();
          await vi.waitFor(async () => expect((await profiles(workerTmp)).length).toBe(0), {
            timeout: 10_000,
          });
          if (scenario === "cancelled-before-successor") {
            const successor = await send("successor after cancelled initial GitHub launch");
            expect(
              await operator.request("agent.wait", { runId: successor, timeoutMs: 90_000 }),
            ).toMatchObject({ status: "ok" });
            await settlement.wait(operator, key, signal);
            await node.waitForWorkersIdle();
            expect(launches().length).toBe(0);
            const successorLaunches = launches(successor);
            expect(successorLaunches.length).toBe(1);
            expect(digest(successorLaunches[0]?.descriptor.assignment.github?.token ?? "")).toBe(
              digest(TOKEN),
            );
            expect((await profiles(workerTmp)).length).toBe(0);
          }
          console.log(
            "INITIAL_GITHUB_LAUNCH_PROOF " +
              JSON.stringify({
                scenario,
                requestCompletedBeforeEffect: true,
                launches: launches().length,
                installedProfileObserved: scenario === "allowed",
                profilesAfterSettlement: 0,
              }),
          );
        },
        () => {
          release.resolve();
          provider?.releaseAll();
        },
        async () => {
          if (writer) {
            await closeGatewayTestWebSocket(writer);
          }
        },
        () => node?.stop(),
        () => operator?.stop(),
        () => owner.stop(),
        () => provider?.stop(),
        () => github?.close(),
        () => published && closeWireServer(published.server),
        () => fs.rm(root, { recursive: true, force: true }),
      );
    },
  );
}
