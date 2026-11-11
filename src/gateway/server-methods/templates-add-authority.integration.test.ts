import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "../../config/config.js";
import {
  registerRuntimeConfigWriteListener,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { getRuntimeConfigWriteApplication } from "../../config/runtime-write-application.js";
import { assertAgentInitializationCompleteInWorker } from "../../config/sessions/agent-initialization.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { parseCanonicalSqliteSessionEntry } from "../../config/sessions/session-entry-json.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { resolveSessionWorkStartError } from "../../config/sessions/session-work-start.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { copyPackageDirInstallTransactionRequest } from "../../infra/install-package-dir.js";
import { clawHubSecurityResponse } from "../../plugins/clawhub.test-fixtures.js";
import { createClawHubArchiveFactory } from "../../plugins/clawhub.test-support.js";
import { resolveDefaultPluginExtensionsDir } from "../../plugins/install-paths.js";
import { readPersistedInstalledPluginIndexInstallRecordsAsync } from "../../plugins/installed-plugin-index-records.js";
import type { PluginLifecycleRuntimeApply } from "../../plugins/lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import type { withResolvedClawHubSource } from "../../templates/clawhub-source.js";
import {
  buildGatewayTemplateAddPlan,
  projectGatewayTemplateAddPlan,
} from "../../templates/gateway-add-plan.js";
import { readTemplateManifestFile } from "../../templates/reader.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { templatesAddHandlers } from "./templates-add.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "./types.js";

const { resolveSource, greeting, instructionFailure, checkpointFailure } = vi.hoisted(() => ({
  checkpointFailure: { pending: false, intent: false },
  instructionFailure: { pending: false, edited: false, interrupted: false, soulWritten: false },
  resolveSource: vi.fn(),
  greeting: vi.fn(async () => {}),
}));
// mock-isolation: Fail the configured session write before commit; admission,
// config publication, disk instructions and the fresh retry use their real owners.
vi.mock("../session-create-target.js", async (original) => {
  const owner = await original<typeof import("../session-create-target.js")>();
  return {
    ...owner,
    checkpointSessionCreateTarget: (
      ...args: Parameters<typeof owner.checkpointSessionCreateTarget>
    ) => {
      if (
        checkpointFailure.pending &&
        (checkpointFailure.intent ? args[2].preparing : args[2].configured)
      ) {
        checkpointFailure.pending = false;
        throw new Error("Fixture configured checkpoint failed before commit");
      }
      return owner.checkpointSessionCreateTarget(...args);
    },
  };
});
const pluginIo = vi.hoisted(() => ({
  detail: vi.fn(),
  artifact: vi.fn(),
  security: vi.fn(),
  download: vi.fn(),
  staged: vi.fn(async (_directory: string) => {}),
}));
// mock-isolation: Inject one disk write failure; real filesystem ownership, rollback,
// canonical continuation and the subsequent request remain unchanged.
vi.mock("../../infra/fs-safe.js", async (original) => {
  const filesystem = await original<typeof import("../../infra/fs-safe.js")>();
  return {
    ...filesystem,
    root: async (...args: Parameters<typeof filesystem.root>) => {
      const root = await filesystem.root(...args);
      return new Proxy(root, {
        get(target, key, receiver) {
          if (key === "remove" && instructionFailure.interrupted) {
            return async () => {
              throw new Error("Fixture interrupted before instruction rollback");
            };
          }
          if (key !== "write") {
            return Reflect.get(target, key, receiver);
          }
          return async (...write: Parameters<typeof root.write>) => {
            if (instructionFailure.pending && write[0] === "IDENTITY.md") {
              instructionFailure.pending = false;
              if (instructionFailure.edited) {
                await fs.writeFile(
                  path.join(root.rootReal, "SOUL.md"),
                  "User edited instructions.\n",
                );
              }
              throw new Error("Fixture instruction disk write failed");
            }
            await root.write(...write);
            if (write[0] === "SOUL.md") {
              instructionFailure.soulWritten = true;
            }
          };
        },
      });
    },
  };
});
// mock-isolation: Fixed registry responses only; all probes, artifact transactions,
// Template consent, installed-index writes and config publication remain real.
vi.mock("../../infra/clawhub-packages.js", async (original) => ({
  ...(await original<typeof import("../../infra/clawhub-packages.js")>()),
  fetchClawHubPackageDetail: pluginIo.detail,
  fetchClawHubPackageArtifact: pluginIo.artifact,
  fetchClawHubPackageSecurity: pluginIo.security,
  reportClawHubPluginInstallTelemetry: vi.fn(async () => {}),
}));
vi.mock("../../infra/clawhub-artifacts.js", async (original) => ({
  ...(await original<typeof import("../../infra/clawhub-artifacts.js")>()),
  downloadClawHubPackageArchive: pluginIo.download,
}));
vi.mock("../../plugins/official-external-plugin-catalog.js", async (original) => ({
  ...(await original<typeof import("../../plugins/official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: vi.fn(async () => ({
    source: "hosted" as const,
    entries: [],
  })),
}));
// mock-isolation: Suspend the genuine installer after staging and its original
// artifact review, before publication. Preserve the private transaction carrier
// and every original final-effect guard; never emulate an authority check here.
vi.mock("../../plugins/install.runtime.js", async (original) => {
  const runtime = await original<typeof import("../../plugins/install.runtime.js")>();
  return {
    ...runtime,
    installPackageDir: (params: Parameters<typeof runtime.installPackageDir>[0]) =>
      runtime.installPackageDir(
        copyPackageDirInstallTransactionRequest(params, {
          ...params,
          afterInstall: async (directory: string) => {
            const result = await params.afterInstall?.(directory);
            if (!result || result.ok) {
              await pluginIo.staged(directory);
            }
            return result ?? { ok: true as const };
          },
        }),
      ),
  };
});
// mock-isolation: Registry delivery is held external I/O. Request authority, planning,
// config writes, leases, ordinary admission and session finalization stay real.
vi.mock("../../templates/clawhub-source.js", async (original) => ({
  ...(await original<typeof import("../../templates/clawhub-source.js")>()),
  withResolvedClawHubSource: resolveSource,
}));
// mock-isolation: No model runs here; canonical session preparation/finalization is real.
vi.mock("./agents-onboarding.js", async (original) => ({
  ...(await original<typeof import("./agents-onboarding.js")>()),
  startAgentOnboardingConversation: greeting,
}));
// mock-isolation: There is no websocket roster in this request-owner composition.
vi.mock("./session-change-event.js", () => ({ emitSessionsChanged: vi.fn() }));

afterEach(async () => {
  vi.clearAllMocks();
  await closeOpenClawStateDatabaseAsync();
});
const agentId = "authority-fixture";
const sessionKey = "agent:authority-fixture:main";
const coordinate = { packageName: "@fixture/authority-template", version: "1.0.0" };
const trust = {
  riskAcknowledgementRequired: false,
  trustRecord: {
    clawhubTrustDisposition: "clean" as const,
    clawhubTrustCheckedAt: "2026-11-09T00:00:00.000Z",
  },
};

const createPluginArchive = createClawHubArchiveFactory(afterEach);

it.each([
  "allowed",
  "source",
  "admission-runtime",
  "initialization-runtime",
  "source-retry",
  "initialization-retry",
  "instruction-retry",
  "instruction-edited",
  "checkpoint-retry",
  "checkpoint-workspace-edited",
  "checkpoint-config-edited",
  "intent-retry",
  "instruction-interrupted",
] as const)(
  "retains original templates.add.apply administrator through final owners: %s",
  async (boundary) => {
    await withOpenClawTestState({ label: "template-request-authority" }, async (state) => {
      let config: OpenClawConfig = {
        gateway: { controlUi: { experimental: { templates: true } } },
        agents: {
          entries: { main: { workspace: state.path("existing-workspace") } },
          defaults: { model: "ollama/test-model" },
        },
      };
      await state.writeConfig(config);
      setRuntimeConfigSnapshot(config);
      const root = state.path("registry-artifact");
      await fs.mkdir(root);
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({
          name: coordinate.packageName,
          version: coordinate.version,
          openclaw: { template: "CLAW.md" },
        }),
      );
      await fs.writeFile(path.join(root, "SOUL.md"), "Only verified Template instructions.\n");
      await fs.writeFile(path.join(root, "IDENTITY.md"), "Verified identity instructions.\n");
      instructionFailure.pending = boundary.startsWith("instruction-");
      instructionFailure.edited = boundary === "instruction-edited";
      instructionFailure.soulWritten = false;
      instructionFailure.interrupted = boundary === "instruction-interrupted";
      checkpointFailure.pending = boundary.startsWith("checkpoint-") || boundary === "intent-retry";
      checkpointFailure.intent = boundary === "intent-retry";
      const manifestPath = path.join(root, "CLAW.md");
      await fs.writeFile(
        manifestPath,
        "---\n" +
          JSON.stringify({
            schemaVersion: 1,
            agent: { id: agentId, name: "Verified Authority Fixture" },
            workspace: {
              bootstrapFiles: {
                "SOUL.md": { source: "SOUL.md" },
                "IDENTITY.md": { source: "IDENTITY.md" },
              },
            },
          }) +
          "\n---\n",
      );
      const source = await readTemplateManifestFile(root);
      if (!source.ok) {
        throw new Error(JSON.stringify(source.diagnostics));
      }
      source.source = {
        ...source.source,
        kind: "package",
        name: coordinate.packageName,
        version: coordinate.version,
        integrityKind: "artifact",
      };
      const review = projectGatewayTemplateAddPlan(
        await buildGatewayTemplateAddPlan(source, { config, agentId, sourceMcpServers: {} }),
        source,
        trust,
        config,
      );
      expect(review.blockers).toEqual([]);
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const persist = vi.fn(async () => source);
      let downloadFailed = false;
      resolveSource.mockImplementation(
        async (input: Parameters<typeof withResolvedClawHubSource>[0]) => {
          if (boundary === "source-retry" && !downloadFailed) {
            downloadFailed = true;
            throw new Error("Temporary registry download failure");
          }
          if (boundary === "source") {
            reached.resolve();
            await release.promise;
          }
          return { value: await input.run(source, trust, persist), ...trust };
        },
      );
      let writes = 0;
      const unsubscribe = registerRuntimeConfigWriteListener((event) => {
        const application = getRuntimeConfigWriteApplication(event);
        if (!application) {
          return;
        }
        const claim = application.claim();
        if (!claim) {
          throw new Error("Runtime notification did not own its write");
        }
        writes += 1;
        config = event.sourceConfig;
        setRuntimeConfigSnapshot(config);
        if (
          (boundary === "admission-runtime" && writes === 1) ||
          (boundary === "initialization-runtime" && writes === 2)
        ) {
          reached.resolve();
          void release.promise.then(() => claim.settle("applied"));
        } else if (boundary === "initialization-retry" && writes === 2) {
          claim.settle("failed");
        } else {
          claim.settle("applied");
        }
      });
      const originalAdministrator = { current: true };
      const respond = vi.fn<RespondFn>();
      const broadcast = vi.fn();
      const options = {
        req: { type: "req", id: "original-admin-add", method: "templates.add.apply" },
        params: { source: coordinate, agentId, planIntegrity: review.planIntegrity },
        respond,
        client: {
          connId: "original-administrator",
          connect: {
            role: "operator",
            scopes: ["operator.admin"],
            client: { mode: "ui" },
          },
        },
        hasCurrentClientAuthority: () => originalAdministrator.current,
        context: { getRuntimeConfig: () => config, broadcastToConnIds: broadcast },
        isWebchatConnect: () => false,
      } as unknown as GatewayRequestHandlerOptions;
      const request = Promise.resolve(templatesAddHandlers["templates.add.apply"]!(options));
      const settled = request.then(() => "settled" as const);
      try {
        if (boundary === "instruction-edited") {
          await request;
          expect(instructionFailure.soulWritten).toBe(true);
          expect(respond.mock.calls[0]?.[1]).toMatchObject({
            agentRetained: true,
            initializationPending: true,
            status: "partial",
          });
          const workspace = config.agents!.entries![agentId]!.workspace!;
          expect(await fs.readFile(path.join(workspace, "SOUL.md"), "utf8")).toBe(
            "User edited instructions.\n",
          );
          respond.mockClear();
          await templatesAddHandlers["templates.add.apply"]!({
            ...options,
            req: { ...options.req, id: "edited-instruction-retry" },
          });
          expect(respond.mock.calls[0]?.[0]).toBe(false);
          expect(greeting).not.toHaveBeenCalled();
          return;
        }
        let retainedSessionId: string | undefined;
        if (
          boundary === "source-retry" ||
          boundary === "initialization-retry" ||
          boundary === "instruction-retry" ||
          boundary.startsWith("checkpoint-") ||
          boundary === "intent-retry" ||
          boundary === "instruction-interrupted"
        ) {
          await request;
          expect(respond.mock.calls[0]?.[1]).toMatchObject({
            agentRetained: true,
            initializationPending: true,
            status: "partial",
          });
          retainedSessionId = (await readSessionEntryReadOnlyInWorker({ agentId, sessionKey }))
            ?.sessionId;
          expect(retainedSessionId).toBeTruthy();
          expect(greeting).not.toHaveBeenCalled();
          const workspace = config.agents!.entries![agentId]!.workspace!;
          if (boundary === "intent-retry") {
            expect(writes).toBe(1);
            expect(await fs.readdir(workspace)).not.toContain("SOUL.md");
          }
          if (boundary === "instruction-interrupted") {
            expect(writes).toBe(1);
            expect(await fs.readFile(path.join(workspace, "SOUL.md"), "utf8")).toBe(
              "Only verified Template instructions.\n",
            );
            instructionFailure.interrupted = false;
          }
          if (boundary === "checkpoint-workspace-edited") {
            await fs.writeFile(
              path.join(workspace, "SOUL.md"),
              "User edited after interruption.\n",
            );
          } else if (boundary === "checkpoint-config-edited") {
            config = {
              ...config,
              agents: {
                ...config.agents,
                entries: {
                  ...config.agents!.entries,
                  [agentId]: { ...config.agents!.entries![agentId], name: "User edited agent" },
                },
              },
            };
            await state.writeConfig(config);
            setRuntimeConfigSnapshot(config);
          }
          await closeOpenClawStateDatabaseAsync();
          respond.mockClear();
          await templatesAddHandlers["templates.add.apply"]!({
            ...options,
            req: { ...options.req, id: "retained-admin-retry" },
          });
          if (
            boundary === "checkpoint-workspace-edited" ||
            boundary === "checkpoint-config-edited"
          ) {
            expect(respond.mock.calls[0]?.[0]).toBe(false);
            expect(writes).toBe(2);
            expect(greeting).not.toHaveBeenCalled();
            expect((await readConfigFileSnapshot()).config.agents?.entries?.[agentId]?.name).toBe(
              boundary === "checkpoint-config-edited"
                ? "User edited agent"
                : "Verified Authority Fixture",
            );
            expect(await fs.readFile(path.join(workspace, "SOUL.md"), "utf8")).toBe(
              boundary === "checkpoint-workspace-edited"
                ? "User edited after interruption.\n"
                : "Only verified Template instructions.\n",
            );
            expect(
              (await readSessionEntryReadOnlyInWorker({ agentId, sessionKey }))?.sessionId,
            ).toBe(retainedSessionId);
            return;
          }
        }
        const successful =
          boundary === "allowed" ||
          boundary === "source-retry" ||
          boundary === "initialization-retry" ||
          boundary === "instruction-retry" ||
          boundary === "checkpoint-retry" ||
          boundary === "intent-retry" ||
          boundary === "instruction-interrupted";
        if (!successful) {
          expect(
            await Promise.race([reached.promise.then(() => "held" as const), settled]),
            JSON.stringify(respond.mock.calls),
          ).toBe("held");
          const pending = await readSessionEntryReadOnlyInWorker({ agentId, sessionKey });
          expect(pending?.initializationPending).toBe(true);
          expect(resolveSessionWorkStartError(sessionKey, pending)).toContain("still initializing");
          // Revoke outside the suspended request, not inside its guard.
          originalAdministrator.current = false;
          release.resolve();
        }
        await request;
        expect(respond).toHaveBeenCalledOnce();
        const [ok, result] = respond.mock.calls[0]!;
        expect(ok, JSON.stringify(respond.mock.calls)).toBe(true);
        expect(result, JSON.stringify(result)).toMatchObject({
          agentId,
          status: successful ? "complete" : "partial",
        });
        const stored = (await readConfigFileSnapshot()).config;
        expect(stored.agents?.entries).toHaveProperty(agentId);
        const entry = await readSessionEntryReadOnlyInWorker({ agentId, sessionKey });
        expect(entry?.sessionId).toBeTruthy();
        const workspace = stored.agents!.entries![agentId]!.workspace!;
        if (successful) {
          if (retainedSessionId) {
            expect(entry?.sessionId).toBe(retainedSessionId);
          }
          expect(entry?.initializationPending).toBeUndefined();
          expect(resolveSessionWorkStartError(sessionKey, entry)).toBeUndefined();
          expect(await fs.readFile(path.join(workspace, "SOUL.md"), "utf8")).toBe(
            "Only verified Template instructions.\n",
          );
          expect(stored.agents!.entries![agentId]!.name).toBe("Verified Authority Fixture");
          expect(greeting).toHaveBeenCalledOnce();
          if (retainedSessionId) {
            expect(writes).toBe(2);
          }
        } else {
          expect(result).toMatchObject({ agentRetained: true, initializationPending: true });
          expect(entry?.initializationPending).toBe(true);
          expect(greeting).not.toHaveBeenCalled();
          expect(writes).toBe(boundary === "initialization-runtime" ? 2 : 1);
          if (boundary !== "initialization-runtime") {
            expect(await fs.readdir(workspace)).not.toContain("SOUL.md");
            expect(stored.agents!.entries![agentId]!.name).toBe(agentId);
            expect(persist).not.toHaveBeenCalled();
          }
        }
      } finally {
        release.resolve();
        await request;
        unsubscribe();
      }
    });
  },
);

it.each(["allowed", "revoked"] as const)(
  "retains original Template requester at real plugin artifact publication: %s",
  async (authority) => {
    await withOpenClawTestState(
      {
        label: "template-plugin-request-authority",
        env: {
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
          OPENCLAW_CLAWHUB_URL: undefined,
          CLAWHUB_URL: undefined,
        },
      },
      async (state) => {
        const pluginId = "authority-plugin";
        const pluginPackage = "@fixture/authority-plugin";
        const pluginManifest = JSON.stringify({
          id: pluginId,
          contracts: { tools: ["authority.read"] },
          configSchema: { type: "object" },
        });
        const archive = await createPluginArchive({
          "package.json": JSON.stringify({
            name: pluginPackage,
            version: "1.0.0",
            openclaw: { extensions: ["./index.js"] },
          }),
          "openclaw.plugin.json": pluginManifest,
          "index.js": "export default { register() {} };\n",
        });
        pluginIo.detail.mockResolvedValue({
          package: {
            name: pluginPackage,
            family: "code-plugin",
            channel: "community",
            runtimeId: pluginId,
            latestVersion: "1.0.0",
            createdAt: 0,
            updatedAt: 0,
          },
        });
        pluginIo.artifact.mockResolvedValue({
          version: { version: "1.0.0", sha256hash: archive.integrity },
        });
        pluginIo.security.mockResolvedValue(clawHubSecurityResponse(pluginPackage, "1.0.0"));
        pluginIo.download.mockResolvedValue({ ...archive, cleanup: async () => {} });
        let config: OpenClawConfig = {
          gateway: { controlUi: { experimental: { templates: true } } },
          agents: {
            entries: { main: { workspace: state.path("existing-workspace") } },
            defaults: { model: "ollama/test-model" },
          },
        };
        await state.writeConfig(config);
        setRuntimeConfigSnapshot(config);
        const root = state.path("registry-artifact");
        await fs.mkdir(root);
        await fs.writeFile(
          path.join(root, "package.json"),
          JSON.stringify({
            name: coordinate.packageName,
            version: coordinate.version,
            openclaw: { template: "CLAW.md" },
          }),
        );
        const manifestPath = path.join(root, "CLAW.md");
        await fs.writeFile(
          manifestPath,
          "---\n" +
            JSON.stringify({
              schemaVersion: 1,
              agent: { id: agentId },
              packages: [
                { kind: "plugin", source: "clawhub", ref: pluginPackage, version: "1.0.0" },
              ],
            }) +
            "\n---\n",
        );
        const source = await readTemplateManifestFile(root);
        if (!source.ok) {
          throw new Error(JSON.stringify(source.diagnostics));
        }
        source.source = {
          ...source.source,
          kind: "package",
          name: coordinate.packageName,
          version: coordinate.version,
          integrityKind: "artifact",
        };
        const review = projectGatewayTemplateAddPlan(
          await buildGatewayTemplateAddPlan(source, { config, agentId, sourceMcpServers: {} }),
          source,
          trust,
          config,
        );
        expect(review.blockers).toEqual([]);
        expect(review.pluginReviews).toHaveLength(1);
        resolveSource.mockImplementation(
          async (input: Parameters<typeof withResolvedClawHubSource>[0]) => ({
            value: await input.run(source, trust, async () => source),
            ...trust,
          }),
        );
        const originalAdministrator = { current: true };
        const reached = Promise.withResolvers<string>();
        const release = Promise.withResolvers<void>();
        pluginIo.staged.mockImplementation(async (directory) => {
          reached.resolve(directory);
          await release.promise;
        });
        const unsubscribe = registerRuntimeConfigWriteListener((event) => {
          config = event.sourceConfig;
          setRuntimeConfigSnapshot(config);
          getRuntimeConfigWriteApplication(event)?.claim()?.settle("applied");
        });
        // mock-isolation: Runtime activation is a supplied Gateway dependency;
        // reload ownership, expected-source checks and persistent effects stay real.
        const activate = vi.fn<PluginLifecycleRuntimeApply>(async (input) => {
          input.assertInvokerOwned?.();
          return {
            operationId: "authority-plugin-activation",
            generation: 1,
            pluginIds: [...input.pluginIds],
            sourceDigests: { ...input.expectedSourceDigests },
          };
        });
        const respond = vi.fn<RespondFn>();
        const options = {
          req: { type: "req", id: "original-admin-plugin-add", method: "templates.add.apply" },
          params: {
            source: coordinate,
            agentId,
            planIntegrity: review.planIntegrity,
            acknowledgeCapabilities: review.pluginReviews.map((plugin) => ({
              actionId: plugin.actionId,
              pluginId: plugin.pluginId,
              reviewToken: plugin.reviewToken,
              capabilityGrants: plugin.capabilityGrants,
              capabilityGrantsByPluginId: plugin.capabilityGrantsByPluginId,
              acknowledgeRiskWarning: plugin.riskWarning ? (true as const) : undefined,
            })),
          },
          respond,
          client: {
            connId: "original-administrator",
            connect: {
              role: "operator",
              scopes: ["operator.admin"],
              client: { mode: "ui" },
            },
          },
          hasCurrentClientAuthority: () => originalAdministrator.current,
          context: {
            getRuntimeConfig: () => config,
            broadcastToConnIds: vi.fn(),
            applyPluginLifecycleChange: activate,
            broadcast: vi.fn(),
            nodeSendToSession: vi.fn(),
          },
          isWebchatConnect: () => false,
        } as unknown as GatewayRequestHandlerOptions;
        const request = Promise.resolve(templatesAddHandlers["templates.add.apply"]!(options));
        const installedDir = path.join(resolveDefaultPluginExtensionsDir(state.env), pluginId);
        try {
          const held = await Promise.race([
            reached.promise.then((directory) => ({ directory })),
            request.then(() => ({ settled: true as const })),
          ]);
          expect(held, JSON.stringify(respond.mock.calls)).toHaveProperty("directory");
          if (!("directory" in held)) {
            throw new Error("Template request settled before the real plugin staging boundary");
          }
          expect(await fs.readFile(path.join(held.directory, "openclaw.plugin.json"), "utf8")).toBe(
            pluginManifest,
          );
          await expect(fs.stat(installedDir)).rejects.toMatchObject({ code: "ENOENT" });
          expect(
            (await readPersistedInstalledPluginIndexInstallRecordsAsync({ env: state.env }))?.[
              pluginId
            ],
          ).toBeFalsy();
          // Verified instructions are ready before optional plugin installation.
          expect(greeting).toHaveBeenCalledOnce();
          expect(
            (await readSessionEntryReadOnlyInWorker({ agentId, sessionKey }))
              ?.initializationPending,
          ).toBeUndefined();
          // Revoke outside the genuinely suspended installer, after consent and
          // staged-byte review; only the production final owner can deny publication.
          if (authority === "revoked") {
            originalAdministrator.current = false;
          }
          release.resolve();
          await request;
          expect(respond).toHaveBeenCalledOnce();
          expect(respond.mock.calls[0]![0]).toBe(true);
          expect(respond.mock.calls[0]![1], JSON.stringify(respond.mock.calls)).toMatchObject({
            agentId,
            status: authority === "allowed" ? "complete" : "partial",
          });
          const record = (
            await readPersistedInstalledPluginIndexInstallRecordsAsync({
              env: state.env,
            })
          )?.[pluginId];
          const stored = (await readConfigFileSnapshot()).config;
          if (authority === "allowed") {
            expect(await fs.readFile(path.join(installedDir, "openclaw.plugin.json"), "utf8")).toBe(
              pluginManifest,
            );
            expect(record).toMatchObject({
              source: "clawhub",
              clawhubPackage: pluginPackage,
              integrity: archive.integrity,
            });
            expect(stored.plugins?.entries?.[pluginId]?.enabled).toBe(true);
            expect(activate).toHaveBeenCalledOnce();
            expect(greeting).toHaveBeenCalledOnce();
          } else {
            await expect(fs.stat(installedDir)).rejects.toMatchObject({ code: "ENOENT" });
            expect(record).toBeFalsy();
            expect(stored.plugins?.entries?.[pluginId]).toBeUndefined();
            expect(activate).not.toHaveBeenCalled();
            // Revocation blocks subsequent plugin effects, not the earlier greeting.
            expect(greeting).toHaveBeenCalledOnce();
            expect(
              (await readSessionEntryReadOnlyInWorker({ agentId, sessionKey }))
                ?.initializationPending,
            ).toBeUndefined();
          }
        } finally {
          release.resolve();
          await request;
          pluginIo.staged.mockImplementation(async () => {});
          unsubscribe();
        }
      },
    );
  },
);

it("loads pre-Template stored session bytes without pending fields and permits ordinary work", async () => {
  await withOpenClawTestState({ label: "template-session-compatibility" }, async () => {
    const config: OpenClawConfig = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(config);
    // Fixed persisted bytes, not an entry produced by the new creation path.
    const entry = parseCanonicalSqliteSessionEntry({
      entry_json:
        '{"sessionId":"existing-session","updatedAt":1780000000000,"label":"Existing conversation","delivery":{"kind":"none"}}',
      current_session_id: "existing-session",
      updated_at: 1780000000000,
    });
    expect(entry).toMatchObject({ sessionId: "existing-session", label: "Existing conversation" });
    if (!entry) {
      throw new Error("Existing session was rejected by canonical decode");
    }
    const target = { agentId: "main", sessionKey: "agent:main:main" };
    await upsertSessionEntryCore(target, entry);
    const stored = await readSessionEntryReadOnlyInWorker(target);
    expect(stored).toMatchObject({ sessionId: "existing-session", label: "Existing conversation" });
    expect(stored?.initializationPending).toBeUndefined();
    expect(stored?.templateInitialization).toBeUndefined();
    expect(resolveSessionWorkStartError(target.sessionKey, stored)).toBeUndefined();
    await expect(
      assertAgentInitializationCompleteInWorker(config, "main"),
    ).resolves.toBeUndefined();
  });
});
