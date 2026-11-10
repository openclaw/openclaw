import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { zstdDecompressSync } from "node:zlib";
import { afterEach, assert, expect, it, vi } from "vitest";
import type { HelloOk } from "../../packages/gateway-protocol/src/index.js";
import type { TemplateLifecyclePlanResult } from "../../packages/gateway-protocol/src/schema/templates.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadCronJobsStore } from "../cron/store.js";
import { testApi as loggingTestApi } from "../logging/logger.test-support.js";
import { clawHubSecurityResponse } from "../plugins/clawhub.test-fixtures.js";
import { createClawHubArchiveFactory } from "../plugins/clawhub.test-support.js";
import { readPersistedInstalledPluginIndexInstallRecordsAsync } from "../plugins/installed-plugin-index-records.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawStateLeaseAsync } from "../state/openclaw-state-lease.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { GatewayClient, type GatewayClientOptions } from "./client.js";
import { writeToolCall } from "./gateway-provider-fixture.test-support.js";
import { pairOperatorDeviceFixture } from "./paired-device.test-support.js";
import { startGatewayServerCore } from "./server-start.js";
import { KERNEL_TEST_ENV } from "./test-helpers.env.js";
import { acquireGatewayE2ePortBlock, startClaimedGateway } from "./test-helpers.listener.js";
import { buildOpenAiResponsesTestModel } from "./test-openai-responses-model.js";

const remote = vi.hoisted(() => ({
  detail: vi.fn(),
  artifact: vi.fn(),
  download: vi.fn(),
  security: vi.fn(),
  policy: vi.fn(),
}));
// mock-isolation: Only remote registry and operator-policy executable I/O are fixed.
// Authenticated RPC, source admission, native installers, files, records and activation stay real.
vi.mock("../infra/clawhub-packages.js", async (original) => ({
  ...(await original<typeof import("../infra/clawhub-packages.js")>()),
  fetchClawHubPackageDetail: remote.detail,
  fetchClawHubPackageArtifact: remote.artifact,
  fetchClawHubPackageSecurity: remote.security,
}));
vi.mock("../infra/clawhub-artifacts.js", async (original) => ({
  ...(await original<typeof import("../infra/clawhub-artifacts.js")>()),
  downloadClawHubPackageArchive: remote.download,
}));
vi.mock("../process/exec.js", async (original) => {
  const actual = await original<typeof import("../process/exec.js")>();
  return {
    ...actual,
    runCommandWithTimeout: (...args: Parameters<typeof actual.runCommandWithTimeout>) =>
      args[0].some((arg) => arg.endsWith("bundled-policy.cjs"))
        ? remote.policy(...args)
        : actual.runCommandWithTimeout(...args),
  };
});
vi.mock("../plugins/official-external-plugin-catalog.js", async (original) => ({
  ...(await original<typeof import("../plugins/official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: async () => ({
    source: "hosted",
    entries: [],
  }),
}));
const createArchive = createClawHubArchiveFactory(afterEach);
const version = "1.0.0";
const token = "template-authority-test-token";
type Kind = "skill" | "plugin" | "clawhub-plugin";

async function makeFixture(kind: Kind, label: string, effectFile?: string) {
  const dependencyId = `${label}-${kind}-probe`;
  const agentId = `${label}-${kind}-template`;
  const packageName = `@openclaw/${agentId}`;
  const pluginName = `@openclaw/${dependencyId}`;
  const dependencyPath = `${kind}s/${dependencyId}`;
  const skillSource = `---\nname: ${dependencyId}\ndescription: Synthetic public research skill.\n---\nCompare public sources.\n`;
  const files: Record<string, string> =
    kind === "skill"
      ? { "SKILL.md": skillSource }
      : {
          "package.json": JSON.stringify({
            name: pluginName,
            version,
            type: "commonjs",
            main: "index.cjs",
            openclaw: { extensions: ["./index.cjs"] },
          }),
          "openclaw.plugin.json": JSON.stringify({
            id: dependencyId,
            contracts: { tools: [`${dependencyId.replaceAll("-", "_")}_tool`] },
            configSchema: { type: "object" },
          }),
          "index.cjs": `module.exports = { id: ${JSON.stringify(dependencyId)}, register(api) {
      api.registerTool({ name: ${JSON.stringify(`${dependencyId.replaceAll("-", "_")}_tool`)}, description: "Synthetic probe",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          ${effectFile ? `require("node:fs").appendFileSync(${JSON.stringify(effectFile)}, "called\\n");` : ""}
          return { content: [{ type: "text", text: "ready" }] };
        } });
    } };`,
        };
  const pluginArchive = kind === "clawhub-plugin" ? await createArchive(files) : undefined;
  const archive = await createArchive({
    "package.json": JSON.stringify({
      name: packageName,
      version,
      openclaw: { template: "CLAW.md" },
    }),
    "CLAW.md": `---\n${JSON.stringify({
      schemaVersion: 1,
      agent: {
        id: agentId,
        ...(effectFile ? { tools: { allow: [`${dependencyId.replaceAll("-", "_")}_tool`] } } : {}),
      },
      [kind === "skill" ? "skills" : "plugins"]: [
        kind === "clawhub-plugin" ? { ref: pluginName, version } : { path: dependencyPath },
      ],
      ...(kind === "plugin" && label === "allowed"
        ? {
            automations: [
              {
                id: "daily-probe",
                enabled: false,
                schedule: { cron: "0 8 * * *", timezone: "UTC" },
                session: "isolated",
                message: "Report the synthetic probe status.",
              },
            ],
          }
        : {}),
    })}\n---\nCompare synthetic public research.\n`,
    ...(pluginArchive
      ? {}
      : Object.fromEntries(
          Object.entries(files).map(([name, content]) => [`${dependencyPath}/${name}`, content]),
        )),
  });
  const sha256 = createHash("sha256")
    .update(await fs.readFile(archive.archivePath))
    .digest("hex");
  return {
    kind,
    packageName,
    pluginName,
    dependencyId,
    agentId,
    pluginArchive,
    archive,
    sha256,
    skillSource,
  };
}
type Fixture = Awaited<ReturnType<typeof makeFixture>>;

function setRemoteFixtures(fixtures: Fixture[]) {
  const lookup = (name: string) => {
    const fixture = fixtures.find(
      (entry) =>
        entry.packageName === name ||
        (entry.kind === "clawhub-plugin" && entry.pluginName === name),
    );
    if (!fixture) {
      throw new Error(`Unexpected registry request: ${name}`);
    }
    return { fixture, external: fixture.pluginName === name };
  };
  remote.detail.mockImplementation(async ({ name }: { name: string }) => {
    const { fixture, external } = lookup(name);
    return {
      package: {
        name,
        displayName: name,
        family: external ? "code-plugin" : "template",
        channel: "official",
        isOfficial: true,
        ownerHandle: "openclaw",
        latestVersion: version,
        updatedAt: 0,
        ...(external ? { runtimeId: fixture.dependencyId } : {}),
      },
      owner: { handle: "openclaw" },
    };
  });
  remote.artifact.mockImplementation(async ({ name }: { name: string }) => {
    const { fixture, external } = lookup(name);
    return external
      ? { version: { version, sha256hash: fixture.pluginArchive!.integrity } }
      : {
          package: { name, family: "template" },
          version,
          artifact: { kind: "npm-pack", sha256: fixture.sha256, npmIntegrity: "sha512-fixture" },
        };
  });
  remote.security.mockImplementation(async ({ name }: { name: string }) => {
    const { fixture, external } = lookup(name);
    return {
      ...clawHubSecurityResponse(name, version, { moderationState: "approved" }),
      package: { name, family: external ? "code-plugin" : "template" },
      release: external
        ? { version }
        : {
            version,
            artifactKind: "npm-pack",
            artifactSha256: fixture.sha256,
            npmIntegrity: "sha512-fixture",
          },
    };
  });
  remote.download.mockImplementation(async ({ name }: { name: string }) => {
    const { fixture, external } = lookup(name);
    return external
      ? { ...fixture.pluginArchive!, cleanup: async () => {} }
      : {
          ...fixture.archive,
          artifact: "clawpack",
          sha256Hex: fixture.sha256,
          npmIntegrity: "sha512-fixture",
          cleanup: async () => {},
        };
  });
}

it.for(["skill", "plugin", "clawhub-plugin"] as const)(
  "fences %s publication for read-only and revoked operators through native Add",
  async (kind, { signal }) => {
    const state = await createOpenClawTestState({
      label: `bundled-${kind}-authority`,
      env: {
        ...KERNEL_TEST_ENV,
        OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: kind === "plugin" ? undefined : "1",
        OPENCLAW_SKIP_PROVIDERS: kind === "plugin" ? undefined : "1",
      },
    });
    const clients: GatewayClient[] = [];
    const release = createDeferredCore();
    const reached = createDeferredCore<string>();
    const policyReturned = createDeferredCore();
    const recoveryRestart = vi.fn(() => {
      throw new Error("Add must hot-apply without restart");
    });
    let server: Awaited<ReturnType<typeof startGatewayServerCore>> | undefined;
    let provider:
      | Awaited<ReturnType<typeof reserveTestPortListener<ReturnType<typeof createServer>>>>
      | undefined;
    try {
      const effectFile = state.path("scheduled-tool-effects.txt");
      const allowed = await makeFixture(
        kind,
        "allowed",
        kind === "plugin" ? effectFile : undefined,
      );
      const toolName = `${allowed.dependencyId.replaceAll("-", "_")}_tool`;
      let providerRequests = 0;
      const providerErrors: unknown[] = [];
      if (kind === "plugin") {
        provider = await reserveTestPortListener({
          offsets: [0],
          signal,
          createListener: () =>
            createServer((request, response) => {
              // Host listener probes are not provider requests.
              if (request.method === "GET" && request.url === "/") {
                request.resume();
                response.writeHead(404).end();
                return;
              }
              providerRequests++;
              void (async () => {
                expect(request.method).toBe("POST");
                expect(request.url).toBe("/v1/responses");
                expect(request.headers.authorization).toBe("Bearer synthetic-scheduling-key");
                const encoded = await buffer(request);
                const body = JSON.parse(
                  (request.headers["content-encoding"] === "zstd"
                    ? zstdDecompressSync(encoded)
                    : encoded
                  ).toString("utf8"),
                );
                expect(body.model).toBe("gpt-4.1");
                if (providerRequests % 2 === 1) {
                  expect(body.tools).toEqual(
                    expect.arrayContaining([expect.objectContaining({ name: toolName })]),
                  );
                  writeToolCall(response, toolName, {});
                } else {
                  expect(body.input).toEqual(
                    expect.arrayContaining([
                      expect.objectContaining({
                        type: "function_call_output",
                        output: expect.stringContaining("ready"),
                      }),
                    ]),
                  );
                  writeOpenAiResponsesText(response, {
                    text: "Synthetic probe is ready.",
                    messageId: `msg_${providerRequests}`,
                    responseId: `resp_${providerRequests}`,
                  });
                }
              })().catch((error: unknown) => {
                providerErrors.push(error);
                response.writeHead(500).end();
              });
            }),
        });
      }
      const revoked = await makeFixture(kind, "revoked");
      setRemoteFixtures([allowed, revoked]);
      const policyPath = state.path("bundled-policy.cjs");
      await fs.writeFile(policyPath, "// Synthetic external operator policy.\n", { mode: 0o700 });
      let armed = false;
      let skillPreflight: string | undefined;
      const finalPolicySources: string[] = [];
      remote.policy.mockImplementation(async (_command: string[], options: { input: string }) => {
        const request = JSON.parse(options.input);
        if (request.targetName === revoked.dependencyId && armed) {
          let final = false;
          if (kind !== "skill") {
            // Native probes stage in an isolated temp root; only the real install
            // stages the dependency tree beside the intended extension target.
            final =
              request.plugin?.contentType === "dependency-tree" &&
              path.dirname(request.sourcePath) ===
                (await fs.realpath(state.statePath("extensions")));
          } else if (revokedWorkspace && (await fs.stat(revokedWorkspace).catch(() => null))) {
            // After workspace staging, the skill owner first re-preflights an
            // immutable copy, disposes it, then supplies a fresh copy to its native
            // archive installer. Bind the gate to that concrete source lifetime.
            if (!skillPreflight) {
              skillPreflight = request.sourcePath;
            } else {
              expect(request.sourcePath).not.toBe(skillPreflight);
              expect(await fs.stat(skillPreflight).catch(() => null)).toBeNull();
              expect(await fs.readFile(path.join(request.sourcePath, "SKILL.md"), "utf8")).toBe(
                revoked.skillSource,
              );
              final = true;
            }
          }
          if (final) {
            finalPolicySources.push(request.sourcePath);
            reached.resolve(request.sourcePath);
            await release.promise;
            policyReturned.resolve();
          }
        }
        return {
          code: 0,
          stdout: JSON.stringify({ protocolVersion: 1, decision: "allow" }),
          stderr: "",
          killed: false,
        };
      });
      const claim = await acquireGatewayE2ePortBlock();
      const port = claim.port;
      if (kind === "plugin") {
        await persistAuthProfileBatch({
          profiles: [
            {
              profileId: "openai:template-scheduling",
              credential: { type: "api_key", provider: "openai", key: "synthetic-scheduling-key" },
            },
          ],
        });
      }
      await state.writeConfig({
        gateway: {
          mode: "local",
          bind: "loopback",
          auth: { mode: "token", token },
          controlUi: { enabled: false, experimental: { templates: true } },
        },
        logging: { level: "error", consoleLevel: "silent", file: state.path("gateway.log") },
        agents: {
          defaults: {
            workspace: state.workspaceDir,
            model: "openai/gpt-4.1",
            models: {
              "openai/gpt-4.1": {
                agentRuntime: { id: "openclaw" },
                params: { transport: "sse", openaiWsWarmup: false },
              },
            },
          },
        },
        ...(provider
          ? {
              models: {
                providers: {
                  openai: {
                    api: "openai-responses",
                    baseUrl: `http://127.0.0.1:${provider.claim.port}/v1`,
                    request: { allowPrivateNetwork: true },
                    models: [buildOpenAiResponsesTestModel("gpt-4.1")],
                  },
                },
              },
              plugins: {
                allow: ["openai", allowed.dependencyId, revoked.dependencyId],
                entries: { openai: { enabled: true } },
                slots: { memory: "none" },
              },
              tools: { codeMode: false, toolSearch: false },
              cron: { enabled: false, triggers: { enabled: false } },
            }
          : {}),
        security: {
          installPolicy: {
            enabled: true,
            exec: { source: "exec", command: process.execPath, args: [policyPath] },
          },
        },
      });
      server = await startClaimedGateway(claim, () =>
        startGatewayServerCore(port, {
          controlUiEnabled: false,
          hotReloadRecovery: recoveryRestart,
        }),
      );
      await server.startupSettled;
      const connect = async (options: {
        scopes: string[];
        token?: string;
        deviceToken?: string;
        deviceIdentity?: GatewayClientOptions["deviceIdentity"];
      }) => {
        const ready = createDeferredCore<HelloOk>();
        const closed = createDeferredCore();
        const client = new GatewayClient({
          url: `ws://127.0.0.1:${port}`,
          clientName: options.deviceToken ? "test" : "gateway-client",
          clientVersion: "1.0.0",
          platform: "test",
          mode: options.deviceToken ? "test" : "backend",
          deviceIdentity: null,
          ...options,
          hostDeps: {
            loadDeviceAuthToken: () => null,
            storeDeviceAuthToken: () => {},
            clearDeviceAuthToken: () => {},
          },
          onHelloOk: (hello) => ready.resolve(hello),
          onConnectError: (error) => ready.reject(error),
          onClose: () => closed.resolve(),
        });
        clients.push(client);
        client.start();
        const hello = await withinTest(ready.promise, signal);
        expect(hello.auth.scopes).toEqual(expect.arrayContaining(options.scopes));
        return { client, closed: closed.promise };
      };
      const admin = await connect({ scopes: ["operator.read", "operator.admin"], token });
      const reader = await connect({ scopes: ["operator.read"], token });
      const creator =
        kind === "plugin"
          ? await pairOperatorDeviceFixture({
              identityPath: state.path("creator", "client", "credentials.sqlite"),
              scopes: ["operator.read", "operator.admin"],
              tokenScopes: ["operator.read", "operator.admin"],
              clientId: "test",
              clientMode: "test",
              callerScopes: ["operator.admin"],
            })
          : undefined;
      if (creator && !creator.issued.ok) {
        throw new Error("Could not issue synthetic creator token");
      }
      const author = creator?.issued.ok
        ? await connect({
            scopes: ["operator.read", "operator.admin"],
            deviceIdentity: creator.identity,
            deviceToken: creator.issued.entry.token,
          })
        : admin;
      const source = (fixture: Fixture) => ({ packageName: fixture.packageName, version });
      const plan = (client: GatewayClient, fixture: Fixture) =>
        client.request<TemplateLifecyclePlanResult>("templates.add.plan", {
          source: source(fixture),
        });
      const params = (fixture: Fixture, review: TemplateLifecyclePlanResult) => ({
        source: source(fixture),
        planIntegrity: review.planIntegrity,
        acknowledgeCapabilities: review.pluginReviews.map((entry) => ({
          actionId: entry.actionId,
          pluginId: entry.pluginId,
          reviewToken: entry.reviewToken,
          capabilityGrants: entry.capabilityGrants,
          capabilityGrantsByPluginId: entry.capabilityGrantsByPluginId,
          ...(entry.riskWarning ? { acknowledgeRiskWarning: true } : {}),
        })),
      });
      const effects = async (fixture: Fixture, workspace: string) => {
        const cfg = JSON.parse(await fs.readFile(state.configPath, "utf8")) as OpenClawConfig;
        const records = await readPersistedInstalledPluginIndexInstallRecordsAsync();
        const dependencyPath =
          kind !== "skill"
            ? state.statePath("extensions", fixture.dependencyId)
            : path.join(workspace, "skills", fixture.dependencyId);
        return {
          agent: cfg.agents?.entries?.[fixture.agentId],
          plugin: records?.[fixture.dependencyId],
          activation: cfg.plugins?.entries?.[fixture.dependencyId],
          published: Boolean(await fs.stat(dependencyPath).catch(() => null)),
        };
      };
      const noEffects = async (fixture: Fixture, workspace: string) =>
        expect(await effects(fixture, workspace)).toEqual({
          agent: undefined,
          plugin: undefined,
          activation: undefined,
          published: false,
        });
      const allowedPlan = await plan(reader.client, allowed);
      expect(allowedPlan.blockers).toEqual([]);
      expect(allowedPlan.target.workspace).toBeTruthy();
      const allowedWorkspace = allowedPlan.target.workspace!;
      await expect(
        reader.client.request("templates.add.apply", params(allowed, allowedPlan)),
      ).rejects.toThrow("missing scope: operator.admin");
      await noEffects(allowed, allowedWorkspace);
      expect(await fs.stat(allowedWorkspace).catch(() => null)).toBeNull();
      expect(
        await author.client.request("templates.add.apply", params(allowed, allowedPlan)),
      ).toMatchObject({ status: "complete" });
      if (kind === "plugin") {
        assert(creator);
        // Preserve the real Gateway handoff: Add must publish its new agent
        // before native scheduling, without a manual config receipt or restart.
        const schedules = await admin.client.request<{ jobs: Array<{ id: string }> }>("cron.list", {
          agentId: allowed.agentId,
          includeDisabled: true,
        });
        expect(schedules.jobs).toEqual([
          expect.objectContaining({
            agentId: allowed.agentId,
            effectiveAgentId: allowed.agentId,
            declarationKey: `template:${allowed.agentId}:daily-probe`,
            enabled: false,
            schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
          }),
        ]);
        expect(JSON.stringify(schedules)).not.toMatch(
          /inferenceBinding|authorizationId|synthetic-/,
        );
        const stored = (await loadCronJobsStore(state.statePath("cron", "jobs.json"))).jobs.find(
          (job) => job.id === schedules.jobs[0]!.id,
        );
        expect(stored).toMatchObject({
          agentId: allowed.agentId,
          enabled: false,
          inferenceBinding: { provider: "openai", profileId: "openai:template-scheduling" },
          operatorSource: {
            source: {
              kind: "gateway",
              snapshot: { device: { deviceId: creator.identity.deviceId } },
            },
          },
        });
        assert(stored?.inferenceBinding);
        expect(stored.payload).not.toHaveProperty("model");
        // Controller B forces the unchanged job; each occurrence restores creator A's authority.
        const run = () =>
          admin.client.request<{ run?: { status: string; error?: string } }>(
            "cron.run",
            { id: stored.id, mode: "force", waitTimeoutMs: 60_000 },
            { timeoutMs: 65_000 },
          );
        const accepted = await run();
        expect(providerErrors).toEqual([]);
        expect(accepted.run).toMatchObject({ status: "ok" });
        expect(providerRequests).toBe(2);
        expect(await fs.readFile(effectFile, "utf8")).toBe("called\n");
        await admin.client.request("device.token.revoke", {
          deviceId: creator.identity.deviceId,
          role: "operator",
        });
        await withinTest(author.closed, signal);
        const refused = await run();
        expect(
          refused.run,
          JSON.stringify({ providerRequests, toolEffects: await fs.readFile(effectFile, "utf8") }),
        ).toMatchObject({
          status: "error",
          error: expect.stringContaining(
            "operator authority that created this automation was refused",
          ),
        });
        expect(providerErrors).toEqual([]);
        expect(providerRequests).toBe(2);
        expect(await fs.readFile(effectFile, "utf8")).toBe("called\n");
        const unchanged = (await loadCronJobsStore(state.statePath("cron", "jobs.json"))).jobs.find(
          (job) => job.id === stored.id,
        );
        expect(unchanged).toEqual({
          ...stored,
          state: unchanged?.state,
          updatedAtMs: unchanged?.updatedAtMs,
        });
      }
      expect(await effects(allowed, allowedWorkspace)).toMatchObject({
        agent: expect.objectContaining({}),
        published: true,
      });
      if (kind !== "skill") {
        expect(await effects(allowed, allowedWorkspace)).toMatchObject({
          plugin: { source: kind === "clawhub-plugin" ? "clawhub" : "archive" },
          activation: { enabled: true },
        });
        const catalog = await admin.client.request("tools.catalog", { agentId: allowed.agentId });
        expect(JSON.stringify(catalog)).toContain(
          `${allowed.dependencyId.replaceAll("-", "_")}_tool`,
        );
      } else {
        expect(
          await fs.readFile(
            path.join(allowedWorkspace, "skills", allowed.dependencyId, "SKILL.md"),
            "utf8",
          ),
        ).toBe(allowed.skillSource);
        const status = await admin.client.request("skills.status", { agentId: allowed.agentId });
        expect(JSON.stringify(status)).toContain(allowed.dependencyId);
      }
      const revokedPlan = await plan(admin.client, revoked);
      expect(revokedPlan.blockers).toEqual([]);
      const revokedWorkspace = revokedPlan.target.workspace!;
      const { identity, issued } = await pairOperatorDeviceFixture({
        identityPath: state.path("device", "client", "credentials.sqlite"),
        scopes: ["operator.read", "operator.admin"],
        tokenScopes: ["operator.read", "operator.admin"],
        clientId: "test",
        clientMode: "test",
        callerScopes: ["operator.admin"],
      });
      if (!issued.ok) {
        throw new Error("Could not issue synthetic device token");
      }
      const device = await connect({
        scopes: ["operator.read", "operator.admin"],
        deviceIdentity: identity,
        deviceToken: issued.entry.token,
      });
      armed = true;
      const reply = device.client.request("templates.add.apply", params(revoked, revokedPlan)).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      const finalSource = await withinTest(
        awaitGateBeforeSettlement(
          reached.promise,
          reply,
          "Add settled before native install policy",
        ),
        signal,
      );
      expect(finalSource).toBeTruthy();
      await noEffects(revoked, revokedWorkspace);
      await admin.client.request("device.token.revoke", {
        deviceId: identity.deviceId,
        role: "operator",
      });
      await withinTest(device.closed, signal);
      release.resolve();
      await withinTest(policyReturned.promise, signal);
      await reply;
      // Join the actual allocation owner after native cleanup, so absence cannot
      // pass while the disconnected request still has installation work in flight.
      await withOpenClawStateLeaseAsync(
        {
          scope: "core:template-add-allocation",
          key: revoked.agentId,
          leaseMs: 60_000,
          waitMs: 5_000,
        },
        captureOpenClawStateWorkerContext({ env: state.env }),
        async () => {
          await noEffects(revoked, revokedWorkspace);
          expect(await fs.stat(finalSource).catch(() => null)).toBeNull();
        },
      );
      expect(finalPolicySources).toHaveLength(1);
      expect(recoveryRestart).not.toHaveBeenCalled();
    } catch (error) {
      await loggingTestApi.flushFileLogQueueForTests();
      const log = await fs.readFile(state.path("gateway.log"), "utf8").catch(() => "");
      throw new Error(
        `${String(error)}\n${log
          .split("\n")
          .filter((line) => /ERROR|failed|templates.add.apply/.test(line))
          .slice(-15)
          .join("\n")}`,
        {
          cause: error,
        },
      );
    } finally {
      release.resolve();
      await runQaGatewayFixture(
        async () => {},
        ...clients.map((client) => () => client.stopAndWait()),
        async () => server?.close(),
        async () => {
          if (provider) {
            provider.listener.closeAllConnections();
            await runQaGatewayFixture(
              async () => {},
              provider.releaseListener,
              provider.claim.release,
            );
          }
        },
        () => state.cleanup(),
        () => clearPluginMetadataLifecycleCaches(),
      );
      remote.policy.mockReset();
    }
  },
);
