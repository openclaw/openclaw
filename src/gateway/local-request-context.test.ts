import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as preparedModelCatalog from "../agents/prepared-model-catalog.js";
import type { PublishedModelCatalogOwnerCandidate } from "../agents/prepared-model-catalog.types.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import {
  callInProcessGatewayTool,
  hasGatewayToolRoutingContext,
  hasInProcessGatewayToolContext,
} from "../agents/tools/in-process-gateway.js";
import type { CliDeps } from "../cli/deps.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import { loadCronStore, resolveCronJobsStorePath, saveCronStore } from "../cron/store.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayContextResolver,
} from "../plugins/runtime/gateway-request-scope.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withLocalGatewayRequestScope } from "./local-request-context.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  dispatchGatewayMethodInProcess,
  dispatchGatewayMethodInProcessRaw,
} from "./server-plugins.js";

const createAgentTurnService = vi.hoisted(() =>
  vi.fn<typeof import("./agent-turn/agent-turn-service.js").createAgentTurnService>(),
);

vi.mock("./agent-turn/agent-turn-service.js", () => ({ createAgentTurnService }));

type PublishedOwnerSnapshot = Awaited<
  ReturnType<typeof preparedModelCatalog.loadPublishedPreparedModelCatalogOwnerSnapshot>
>;

const asPublishedOwner = (value: PublishedModelCatalogOwnerCandidate): PublishedOwnerSnapshot =>
  value as unknown as PublishedOwnerSnapshot;

function modelFixture(agentId: string, prefix: string) {
  const agentDir = `/tmp/${prefix}-agent`;
  const workspaceDir = `/tmp/${prefix}-workspace`;
  const cfg: OpenClawConfig = {
    agents: { entries: { [agentId]: { agentDir, workspace: workspaceDir } } },
  };
  const candidate: PublishedModelCatalogOwnerCandidate = {
    catalogOwner: { agentId, workspaceDir },
    agentId,
    agentDir,
    workspaceDir,
    config: cfg,
    observationConfig: cfg,
    isCurrent: () => true,
    authModes: {},
    authStore: { version: 1, profiles: {} },
    metadataSnapshot: createPluginMetadataSnapshotFixture(),
    modelCatalog: { entries: [], routeVariants: [] },
  };
  return { cfg, candidate };
}

function withConfig<T>(cfg: OpenClawConfig, run: () => T) {
  return withLocalGatewayRequestScope({ deps: {} as CliDeps, getRuntimeConfig: () => cfg }, run);
}

function localContext() {
  const context = getPluginRuntimeGatewayRequestScope()?.context;
  if (!context) {
    throw new Error("expected local gateway request context");
  }
  return context;
}

describe("local gateway request context", () => {
  it("keeps local RPC available without claiming Gateway routing or readiness", async () => {
    await withConfig({ gateway: { port: 19970 } }, async () => {
      const context = localContext();
      const expectLocalRouting = () => {
        expect(hasInProcessGatewayToolContext()).toBe(true);
        expect(hasGatewayToolRoutingContext()).toBe(false);
      };
      expectLocalRouting();
      expect(context.isConfigReloadSettled()).toBe(false);
      await withGatewayToolCallerIdentity(
        { agentId: "main", sessionKey: "agent:main:local", gatewayContextResolver: () => context },
        expectLocalRouting,
      );
    });
    expect(hasGatewayToolRoutingContext()).toBe(false);
  });

  it("retains caller Gateway ownership after retirement inside a local scope", async () => {
    let current: GatewayRequestContext | undefined = {} as GatewayRequestContext;
    const resolver = () => current;
    const check = async () => {
      expect(hasGatewayToolRoutingContext()).toBe(true);
      current = undefined;
      expect(hasGatewayToolRoutingContext()).toBe(true);
      await expect(callInProcessGatewayTool("node.list", {})).rejects.toThrow(
        "Gateway instance unavailable for node.list",
      );
    };
    await withConfig({}, () =>
      withGatewayToolCallerIdentity(
        { agentId: "main", sessionKey: "agent:main:worker", gatewayContextResolver: resolver },
        check,
      ),
    );
    expect(hasGatewayToolRoutingContext()).toBe(false);
  });

  it("reuses an outer retired Gateway resolver", async () => {
    const resolveGatewayContext = () => undefined;
    const getRuntimeConfig = vi.fn(() => ({}));
    await withPluginRuntimeGatewayContextResolver(resolveGatewayContext, () =>
      withLocalGatewayRequestScope({ deps: {} as CliDeps, getRuntimeConfig }, async () => {
        const scope = getPluginRuntimeGatewayRequestScope();
        expect(scope?.resolveGatewayContext).toBe(resolveGatewayContext);
        expect(scope?.context).toBeUndefined();
        expect(hasGatewayToolRoutingContext()).toBe(true);
      }),
    );
    expect(getRuntimeConfig).not.toHaveBeenCalled();
  });

  it("binds typed agent turns to the embedded context", async () => {
    await withConfig({}, async () => {
      const context = localContext();
      const payload = { runId: "local-turn", status: "accepted" };
      createAgentTurnService.mockReturnValue({
        startTurn: async ({ io }) => io.emitAcceptance([true, payload, undefined]),
        prepareWaitForTurn: vi.fn(),
        waitForTurn: vi.fn(),
      });

      await expect(
        dispatchGatewayMethodInProcess(
          "agent",
          { message: "local turn", idempotencyKey: "local-turn" },
          { forceSyntheticClient: true, operatorRoleActor: { kind: "system" } },
        ),
      ).resolves.toEqual(payload);
      expect(createAgentTurnService).toHaveBeenCalledWith(
        expect.objectContaining({ context }),
        expect.any(Function),
      );
    });
  });

  it("defaults local model catalog snapshot reads to read-only", async () => {
    const { cfg, candidate } = modelFixture("worker", "local-model-catalog");
    const loadOwner = vi
      .spyOn(preparedModelCatalog, "loadPublishedPreparedModelCatalogOwnerSnapshot")
      .mockResolvedValue(asPublishedOwner(candidate));

    await withConfig(cfg, async () => {
      expect(
        await localContext().loadGatewayModelCatalogSnapshot({ agentId: "worker" }),
      ).toMatchObject({ agentId: "worker", workspaceDir: "/tmp/local-model-catalog-workspace" });
    });

    expect(loadOwner).toHaveBeenCalledWith({ agentId: "worker", config: cfg, readOnly: true });
    loadOwner.mockRestore();
  });

  it("refreshes local models.list auth after login and logout", async () => {
    const { cfg, candidate: base } = modelFixture("main", "local-model-auth");
    const model = {
      provider: "local-auth-provider",
      id: "local-auth-model",
      name: "Local auth model",
      api: "openai-completions" as const,
    };
    const candidate = { ...base, modelCatalog: { entries: [model], routeVariants: [model] } };
    const refreshAuth = vi
      .fn()
      .mockResolvedValueOnce({
        authModes: { "local-auth-provider": "api_key" },
        authStore: {
          version: 1,
          profiles: {
            "local-auth-provider:default": {
              type: "api_key",
              provider: "local-auth-provider",
              key: "local-auth-key-not-real",
            },
          },
        },
      })
      .mockResolvedValueOnce({ authModes: {}, authStore: { version: 1, profiles: {} } });
    let published: PublishedOwnerSnapshot | undefined;
    const readOwner = vi
      .spyOn(preparedModelCatalog, "getPublishedPreparedModelCatalogOwnerSnapshot")
      .mockImplementation(() => published);
    const loadOwner = vi
      .spyOn(preparedModelCatalog, "loadPublishedPreparedModelCatalogOwnerSnapshot")
      .mockImplementation(async () => {
        const auth = await refreshAuth({ providerIds: ["local-auth-provider"] });
        published = asPublishedOwner({
          ...candidate,
          authModes: auth.authModes,
          authStore: auth.authStore,
        });
        return published;
      });

    const list = () =>
      withConfig(cfg, () =>
        dispatchGatewayMethodInProcessRaw("models.list", { view: "configured", refresh: true }),
      );
    const loggedIn = await list();
    const loggedOut = await list();

    expect(loggedIn).toMatchObject({
      ok: true,
      payload: { models: [expect.objectContaining({ id: "local-auth-model", available: true })] },
    });
    expect(loggedOut).toMatchObject({ ok: true, payload: { models: [] } });
    for (const call of [1, 2]) {
      expect(refreshAuth).toHaveBeenNthCalledWith(call, { providerIds: ["local-auth-provider"] });
      expect(loadOwner).toHaveBeenNthCalledWith(
        call,
        expect.objectContaining({ readOnly: false, refreshFullCatalog: true }),
      );
    }
    loadOwner.mockRestore();
    readOwner.mockRestore();
  });

  it("uses the prepared local owner without starting a catalog load", async () => {
    const { cfg, candidate } = modelFixture("main", "local-model-timeout");
    const loadOwner = vi
      .spyOn(preparedModelCatalog, "loadPublishedPreparedModelCatalogOwnerSnapshot")
      .mockImplementation(() => new Promise(() => {}));
    const recheckNativeLogin = vi.fn();
    const readOwner = vi
      .spyOn(preparedModelCatalog, "getPublishedPreparedModelCatalogOwnerSnapshot")
      .mockReturnValue({ ...asPublishedOwner(candidate), recheckNativeLogin });

    const result = await withConfig(cfg, () =>
      dispatchGatewayMethodInProcessRaw("models.list", { view: "default" }),
    );

    expect(result).toMatchObject({ ok: true, payload: { models: [] } });
    expect(loadOwner).not.toHaveBeenCalled();
    expect(readOwner).toHaveBeenCalledTimes(2);
    expect(recheckNativeLogin).toHaveBeenCalledOnce();
    loadOwner.mockRestore();
    readOwner.mockRestore();
  });

  it("commits agent deletion through the canonical cron store", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-local-cron-delete-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const cfg = {
      cron: { store: path.join(stateDir, "cron", "jobs.json") },
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: {}, worker: {} },
      },
    } as OpenClawConfig;
    try {
      const storePath = resolveCronJobsStorePath();
      const createJob = (id: string, agentId?: string) => makeCronJob({ id, name: id, agentId });
      await saveCronStore(storePath, {
        version: 1,
        jobs: [createJob("worker-job", "worker"), createJob("agentless-system-job")],
      });
      await withConfig(cfg, async () => {
        await expect(
          localContext().cron.removeAgentJobsTransactional("worker", async () => "committed"),
        ).resolves.toBe("committed");
      });
      expect((await loadCronStore(storePath)).jobs.map((job) => job.id)).toEqual([
        "agentless-system-job",
      ]);
    } finally {
      closeOpenClawStateDatabaseForTest();
      vi.unstubAllEnvs();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

it("keeps standalone embedded RPC available inside its session admission", async () => {
  const { beginSessionEffect } = await import("../sessions/session-controller.lifecycle.js");
  const cfg = { agents: { defaults: {} } };
  await withConfig(cfg, async () => {
    const readIdentity = () =>
      dispatchGatewayMethodInProcessRaw("agent.identity.get", { agentId: "main" });
    await expect(readIdentity()).resolves.toMatchObject({ ok: true, payload: { agentId: "main" } });
    const admission = await beginSessionEffect({
      scope: "local-rpc-admission-regression",
      identities: ["agent:main:local-rpc"],
      assertAllowed: () => {},
    });
    try {
      await admission.run(() => expect(readIdentity()).resolves.toMatchObject({ ok: true }));
    } finally {
      admission.release();
    }
  });
});
