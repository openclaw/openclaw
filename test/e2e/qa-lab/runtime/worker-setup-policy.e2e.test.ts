import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { z } from "zod";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/version.js";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import { readBuildIdFromBuildInfoForModuleUrl } from "../../../../src/version.js";
import {
  acquireGatewayTestWebSocket,
  closeGatewayTestWebSocket,
} from "../../../helpers/gateway-websocket.js";
import { withinTest } from "../../../helpers/promise.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { startPairedNodeWorkerLifecycleProvider } from "./paired-node-worker-lifecycle-provider.js";
import {
  closeWireServer,
  connectWireClient,
  createPublishedWireWorkspace,
  startPairedNodeWorkerGateway,
  type WireGateway,
} from "./paired-node-worker-wire-fixture.js";
import { startManagedSetupBackend } from "./test-support/managed-setup-backend.js";
import {
  command,
  githubFixture,
  gatewayTlsFixture,
  request,
  effectFixture,
  gitWrapper,
  preparationFacts,
  SOURCE_MARKER,
  PREPARATION_MARKER,
  CHECKOUT_MARKER,
} from "./test-support/managed-setup-fixtures.test-support.js";
import {
  SETUP_PROOF_ACTOR,
  SETUP_PROOF_GITHUB_TOKEN,
  SETUP_PROOF_REMOTE,
} from "./test-support/setup-repository-integration/api.js";

// Reuses existing container E2E opt-in inputs; never pulls images or allocates paid capacity.
const enabled = process.platform === "linux" && process.env.OPENCLAW_DOCKER_NODE_WORKER_E2E === "1";
const image = process.env.OPENCLAW_DOCKER_NODE_WORKER_IMAGE;
const PASSWORD = "synthetic-setup-local-password";
const integrationId = "setup-proof-repository";
const modes = ["repository", "image"] as const;
const scenarios = ["allowed", "disabled", "non-admin", "revoked"] as const;
const Placement = z.object({
  environmentId: z.string(),
  remoteWorkspaceDir: z.string(),
  state: z.literal("active"),
});

for (const mode of modes) {
  for (const scenario of scenarios) {
    it.skipIf(!enabled)(
      "managed setup policy: " + mode + " " + scenario,
      { timeout: 420_000 },
      async ({ signal }) => {
        assert(image, "Set OPENCLAW_DOCKER_NODE_WORKER_IMAGE to an existing trusted image");
        const root = await fs.mkdtemp(path.join(process.cwd(), ".openclaw/tmp/setup-policy-"));
        const owner = createQaGatewayChild();
        const entered = createDeferredCore();
        const release = createDeferredCore();
        let armed = false;
        let heldLease: string | undefined;
        let gateway: WireGateway | undefined;
        let operator: GatewayClient | undefined;
        let writer: WebSocket | undefined;
        let backend: Awaited<ReturnType<typeof startManagedSetupBackend>> | undefined;
        let effects: Awaited<ReturnType<typeof effectFixture>> | undefined;
        let github: Awaited<ReturnType<typeof githubFixture>> | undefined;
        let repository: Awaited<ReturnType<typeof createPublishedWireWorkspace>> | undefined;
        let provider:
          | Awaited<ReturnType<typeof startPairedNodeWorkerLifecycleProvider>>
          | undefined;
        let gatewayTls: Awaited<ReturnType<typeof gatewayTlsFixture>> | undefined;
        let evidence: unknown;
        let bodyCompleted = false;
        let transport: { owner: string; name: string } | undefined;
        const marker = "SETUP-PROOF-" + mode + "-" + scenario;
        await runQaGatewayFixture(
          async () => {
            effects = await effectFixture();
            repository = await createPublishedWireWorkspace(
              path.join(root, "repository"),
              effects.files,
              { smartHttp: true },
            );
            await command([
              "node",
              "--check",
              path.join(repository.source, ".openclaw/setup-effect.mjs"),
            ]);
            await command([
              "git",
              "-C",
              repository.source,
              "remote",
              "set-url",
              "origin",
              SETUP_PROOF_REMOTE,
            ]);
            const address = repository.server.address();
            assert(address && typeof address !== "string");
            const hostGit = await gitWrapper(
              path.join(root, "gateway-bin"),
              "http://127.0.0.1:" + address.port + "/repo.git",
            );
            const callback = (gatewayTls = await gatewayTlsFixture(root));
            const guestGit = await gitWrapper(
              path.join(root, "guest-bin"),
              (await callback.proxyTo(address.port)) + "/repo.git",
              "/usr/local/share/ca-certificates/setup-gateway.crt",
            );
            backend = await startManagedSetupBackend({
              root: path.join(root, "backend"),
              image,
              gitWrapperPath: guestGit,
              gatewayCaPath: callback.cert,
              gitHttps: {
                repositoryPath: new URL(SETUP_PROOF_REMOTE).pathname,
                port: address.port,
                keyPath: callback.key,
                certPath: callback.cert,
              },
              beforeInspect: async (leaseId) => {
                if (!armed || heldLease || scenario !== "revoked") {
                  return;
                }
                const resources = await backend!.listResources();
                if (!resources.containers.some((resource) => resource.leaseId === leaseId)) {
                  return;
                }
                heldLease = leaseId;
                entered.resolve();
                await release.promise;
              },
            });
            github = await githubFixture(root, repository.source);
            provider = await startPairedNodeWorkerLifecycleProvider([marker]);
            transport = { owner: randomUUID(), name: "openclaw-setup-gateway-" + randomUUID() };
            const wrapperConfig = path.join(root, "gateway-command.json");
            await fs.writeFile(
              wrapperConfig,
              JSON.stringify({
                ...transport,
                image,
                repoRoot: process.cwd(),
                artifactRoot: path.join(process.cwd(), ".artifacts"),
                stateRoot: root,
                nodePath: process.execPath,
              }),
            );
            const preload = new URL("./worker-github-api-preload.mjs", import.meta.url);
            preload.searchParams.set("fixture", github.apiBaseUrl);
            const scopes: Array<"operator.admin" | "operator.read" | "operator.write"> =
              scenario === "non-admin"
                ? ["operator.read", "operator.write"]
                : ["operator.admin", "operator.read", "operator.write"];
            const backendBinary = backend.binaryPath;
            gateway = await startPairedNodeWorkerGateway({
              owner,
              providerBaseUrl: provider.baseUrl,
              workspaceDir: repository.source,
              fullAccess: true,
              controlUiEnabled: true,
              rpcPassword: PASSWORD,
              enabledPluginIds: ["crabbox"],
              command: {
                executablePath: process.execPath,
                argsPrefix: [
                  fileURLToPath(
                    new URL("./test-support/managed-setup-gateway-command.mjs", import.meta.url),
                  ),
                  wrapperConfig,
                  "--import",
                  preload.href,
                  "dist/index.js",
                ],
                cwd: process.cwd(),
                tempParentDir: root,
                usePackagedPlugins: false,
              },
              runtimeEnvPatch: {
                OPENCLAW_GATEWAY_TOKEN: undefined,
                OPENCLAW_GATEWAY_PASSWORD: undefined,
                GH_TOKEN: SETUP_PROOF_GITHUB_TOKEN,
                GITHUB_TOKEN: undefined,
                OPENAI_API_KEY: "fixture-key",
                NODE_EXTRA_CA_CERTS: github.cert,
                PATH: path.dirname(hostGit) + path.delimiter + process.env.PATH,
              },
              mutateConfig: (config) => ({
                ...config,
                gateway: {
                  ...config.gateway,
                  publicOrigin: callback.bindGateway(config.gateway?.port),
                  repositoryIntegration: integrationId,
                  trustedProxies: ["127.0.0.1"],
                  controlUi: {
                    ...config.gateway?.controlUi,
                    allowedOrigins: ["http://127.0.0.1:" + config.gateway?.port],
                  },
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
                      writer: {
                        agents: ["qa"],
                        scopes,
                        workerProfiles: ["setup"],
                        sessions: { others: "none" },
                      },
                      revoked: { agents: [], scopes: [], sessions: { others: "none" } },
                    },
                  },
                },
                cloudWorkers: {
                  profiles: {
                    setup: {
                      provider: "crabbox",
                      settings: {
                        binary: backendBinary,
                        provider: "external",
                        target: "linux",
                        class: "local-fixture",
                        warmImage: true,
                        runSetupScript: scenario !== "disabled",
                        ttl: "2h",
                        idleTimeout: "30m",
                      },
                    },
                  },
                },
                plugins: {
                  ...config.plugins,
                  enabled: true,
                  allow: [...new Set([...(config.plugins?.allow ?? []), "crabbox", integrationId])],
                  load: {
                    ...config.plugins?.load,
                    paths: [
                      fileURLToPath(
                        new URL("./test-support/setup-repository-integration", import.meta.url),
                      ),
                    ],
                  },
                  entries: {
                    ...config.plugins?.entries,
                    crabbox: { enabled: true },
                    [integrationId]: { enabled: true, config: { preparedCapacity: mode } },
                  },
                },
              }),
            });
            operator = await connectWireClient({
              gateway,
              role: "operator",
              password: PASSWORD,
              identity: null,
            });
            const buildId = readBuildIdFromBuildInfoForModuleUrl(
              new URL("../../../../dist/index.js", import.meta.url).href,
            );
            assert(buildId);
            writer = new WebSocket(gateway.wsUrl, {
              headers: {
                "x-setup-email": SETUP_PROOF_ACTOR,
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
                scopes,
              },
              signal,
            );
            expect(hello.ok, JSON.stringify(hello.error)).toBe(true);
            const key = "agent:qa:setup-" + mode + "-" + scenario;
            const created = await request(
              writer,
              "sessions.create",
              {
                key,
                agentId: "qa",
                repository: { url: SETUP_PROOF_REMOTE, ref: "main" },
                ...(scenario !== "non-admin" ? { permissionMode: "full" } : {}),
              },
              signal,
            );
            expect(created.ok, JSON.stringify(created.error)).toBe(true);
            expect(effects.effects).toEqual([]);
            armed = true;
            const dispatched = request(
              writer,
              "sessions.dispatch",
              { key, profileId: "setup" },
              signal,
            ).then(
              (value) => ({ kind: "response" as const, value }),
              (error: unknown) => ({ kind: "error" as const, error }),
            );
            if (scenario === "revoked") {
              await withinTest(entered.promise, signal);
              const profiles = z
                .object({
                  profiles: z.array(z.object({ id: z.string(), emails: z.array(z.string()) })),
                })
                .parse(await operator.request("users.list", {}));
              const profile = profiles.profiles.find((p) => p.emails.includes(SETUP_PROOF_ACTOR));
              assert(profile);
              await operator.request("users.setRole", { profileId: profile.id, role: "revoked" });
              release.resolve();
              const result = await withinTest(dispatched, signal);
              if (result.kind === "response") {
                expect(result.value.ok).toBe(false);
              } else {
                expect(String(result.error)).toContain("Requester closed");
              }
              await vi.waitFor(
                async () => {
                  expect(
                    (await backend!.listResources()).containers.some(
                      (r) => r.leaseId === heldLease,
                    ),
                  ).toBe(false);
                  const described = z
                    .object({
                      session: z.object({ placement: z.object({ state: z.string() }).nullish() }),
                    })
                    .parse(await operator!.request("sessions.describe", { key }));
                  expect(described.session.placement?.state).not.toBe("provisioning");
                  expect(described.session.placement?.state).not.toBe("active");
                },
                { timeout: 90_000, interval: 500 },
              );
              expect(effects.effects).toEqual([]);
              expect(backend.receipts.filter((r) => r.command === "run")).toHaveLength(0);
              evidence = { mode, scenario, revoked: true, effects: effects.effects, settled: true };
              bodyCompleted = true;
              return;
            }
            const result = await withinTest(dispatched, signal);
            assert(result.kind === "response");
            expect(result.value.ok, JSON.stringify(result.value.error)).toBe(true);
            const placement = z
              .object({ placement: Placement })
              .parse(result.value.payload).placement;
            const status = z.object({ worker: z.object({ leaseId: z.string() }) }).parse(
              await operator.request("environments.status", {
                environmentId: placement.environmentId,
                includePreparedDetails: true,
              }),
            );
            expect(
              await backend.readFile(
                status.worker.leaseId,
                path.join(placement.remoteWorkspaceDir, SOURCE_MARKER),
              ),
            ).toBe("actual committed checkout\n");
            const allowed = scenario === "allowed";
            const expected = mode === "repository" ? "prepare" : "checkout";
            if (allowed) {
              expect(effects.effects.filter((p) => p === expected).length).toBeGreaterThan(0);
            } else {
              expect(effects.effects).toEqual([]);
            }
            expect(effects.effects.filter((p) => p !== expected)).toEqual([]);
            expect(
              await backend.readFile(
                status.worker.leaseId,
                path.join(
                  placement.remoteWorkspaceDir,
                  mode === "repository" ? PREPARATION_MARKER : CHECKOUT_MARKER,
                ),
              ),
            ).toBe(allowed ? expected : undefined);
            const profile = await preparationFacts(gateway.runtimeEnv, placement.environmentId);
            let source: string;
            if (mode === "image") {
              const facts = z
                .object({
                  runtimePreparation: z.object({
                    source: z.literal("image"),
                    key: z.string().min(1),
                  }),
                  project: z.unknown().optional(),
                })
                .parse(profile);
              expect(facts.project).toBeUndefined();
              source = facts.runtimePreparation.source;
            } else {
              const facts = z
                .object({
                  project: z.object({
                    preparation: z.object({
                      runSetupScript: z.boolean().optional(),
                      key: z.string().min(1),
                    }),
                  }),
                })
                .parse(profile);
              expect(facts.project.preparation.runSetupScript === false).toBe(!allowed);
              source = "project";
            }
            // Dispatch has completed real managed-node preparation and the setup effect.
            // Model-turn launch is a separate contract covered by the initial-launch wire suite.
            evidence = {
              mode,
              scenario,
              source,
              checkout: true,
              effects: [...effects.effects],
            };
            await operator.request("environments.destroy", {
              environmentId: placement.environmentId,
              force: true,
            });
            bodyCompleted = true;
          },
          () => {
            release.resolve();
            provider?.release(marker);
          },
          () => writer && closeGatewayTestWebSocket(writer),
          () => operator?.stop(),
          () => stopQaGatewayFixture(owner, { keepTemp: !bodyCompleted }),
          async () => {
            if (!transport) {
              return;
            }
            const owned = await command([
              "podman",
              "ps",
              "-a",
              "--filter",
              "name=" + transport.name,
              "--filter",
              "label=openclaw.setup-gateway=" + transport.owner,
              "--format",
              "{{.Names}}",
            ]);
            if (owned === transport.name) {
              await command(["podman", "rm", "--force", "--volumes", transport.name]);
              throw new Error("Gateway transport required owned-container recovery");
            }
          },
          () => backend?.close(),
          async () => {
            if (scenario !== "allowed") {
              expect(effects?.effects ?? []).toEqual([]);
            }
            if (backend) {
              expect(await backend.listResources()).toMatchObject({
                containers: [],
                checkpoints: [],
              });
            }
            const output = process.env.OPENCLAW_SETUP_PROOF_OUTPUT_DIR;
            if (output) {
              await fs.mkdir(output, { recursive: true });
              await fs.writeFile(
                path.join(output, mode + "-" + scenario + ".json"),
                JSON.stringify({ evidence, backend: backend?.receipts, cleaned: true }, null, 2),
              );
            }
          },
          () => provider?.stop(),
          () => github?.close(),
          () => gatewayTls?.close(),
          () => effects?.close(),
          () => repository && closeWireServer(repository.server),
          async () => {
            if (bodyCompleted) {
              await fs.rm(root, { recursive: true, force: true });
            } else if (process.env.OPENCLAW_SETUP_PROOF_OUTPUT_DIR) {
              await fs.mkdir(process.env.OPENCLAW_SETUP_PROOF_OUTPUT_DIR, { recursive: true });
              await fs.writeFile(
                path.join(process.env.OPENCLAW_SETUP_PROOF_OUTPUT_DIR, "retained-root.txt"),
                root + "\n",
              );
            }
          },
        );
      },
    );
  }
}
