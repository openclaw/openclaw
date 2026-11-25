import { beforeAll, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import type { ModelsSnapshotEvent } from "../../../packages/gateway-protocol/src/index.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withTestTimeout,
  withinTest,
} from "../../../test/helpers/promise.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { getActiveGatewayRootWorkCount } from "../../process/gateway-work-admission.js";
import { acquireTestPortBlock } from "../../test-utils/port-claims.js";
import * as startupModels from "../server-startup-model-runtime.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../test-helpers.e2e.js";
import * as chatMetadataHandler from "./chat-metadata-handler.js";
import { createModelsTestState } from "./models-integration.test-support.js";

// mock-isolation: Optional startup prewarming must not compete with the catalog request drain.
vi.mock("../server-startup-handler-prewarm.js", () => ({
  scheduleGatewayPrewarm: () => [{ stop() {} }],
}));

// Keep real catalog publication while excluding automatic startup work from the
// manual-RPC root-work assertion.
vi.mock("../server-runtime-services.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server-runtime-services.js")>();
  return {
    ...actual,
    activateGatewayScheduledServices: (
      params: Parameters<typeof actual.activateGatewayScheduledServices>[0],
    ) => actual.activateGatewayScheduledServices({ ...params, minimalTestGateway: true }),
    scheduleGatewayPostReadyMaintenance: () => {},
  };
});

// Compile the server before starting the real Gateway.
beforeAll(() => import("../server-start.js"));

it("connect negotiates snapshots and preserves draft and saved-session catalog scopes", async ({
  signal,
}) => {
  const publications: ModelsSnapshotEvent[] = [];
  const initialPublished = createDeferred();
  const releaseInitialModels = createDeferred();
  const publishModels = startupModels.publishConfiguredModelRuntimeSnapshots;
  using _ = vi
    .spyOn(startupModels, "publishConfiguredModelRuntimeSnapshots")
    .mockImplementationOnce(async (...args) => {
      await releaseInitialModels.promise;
      await publishModels(...args);
    });
  signal.addEventListener("abort", () => releaseInitialModels.resolve(), { once: true });
  await using state = await createModelsTestState("models-connect-publication", {
    env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS },
  });
  const token = "synthetic-catalog-gateway-token";
  await state.writeAuthProfiles(
    {
      version: 1,
      profiles: Object.fromEntries(
        ["saved-account", "replacement-account"].map((account) => [
          `fixture:${account}`,
          { type: "api_key" as const, provider: "fixture", key: `synthetic-${account}-key` },
        ]),
      ),
    },
    "alpha",
  );
  const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
  const { port } = portClaim;
  const clientOptions = {
    token,
    clientName: GATEWAY_CLIENT_IDS.CONTROL_UI,
    mode: GATEWAY_CLIENT_MODES.WEBCHAT,
    origin: `http://127.0.0.1:${port}`,
    scopes: ["operator.admin"],
  } satisfies Omit<Parameters<typeof connectGatewayClient>[0], "url">;
  const connect = async (
    options: Pick<
      Parameters<typeof connectGatewayClient>[0],
      "clientName" | "modelCatalog" | "caps" | "onEvent"
    >,
  ) => {
    const snapshots: ModelsSnapshotEvent[] = [];
    const published = createDeferred();
    const client = await connectGatewayClient({
      ...clientOptions,
      url: `ws://127.0.0.1:${port}`,
      ...options,
      onEvent(event) {
        if (event.event === "models.snapshot") {
          snapshots.push(event.payload as ModelsSnapshotEvent);
          published.resolve();
        }
        options.onEvent?.(event);
      },
    });
    return Object.assign(client, {
      snapshots,
      published: published.promise,
      [Symbol.asyncDispose]: () => disconnectGatewayClient(client),
    });
  };
  const model = (id: string, manualSelectionAllowed?: boolean) => ({
    id,
    provider: "fixture",
    available: true,
    ...(manualSelectionAllowed === undefined ? {} : { manualSelectionAllowed }),
  });
  const snapshot = (
    scope: ModelsSnapshotEvent["scope"],
    models: unknown,
    accountSelection?: unknown,
  ) => [{ scope, catalog: { models, ...(accountSelection ? { accountSelection } : {}) } }];
  const { client, server } = await startGatewayWithClient({
    ...clientOptions,
    portClaim,
    configPath: state.configPath,
    modelCatalog: {},
    sidecarStartup: "defer",
    cfg: {
      gateway: {
        mode: "local",
        auth: { mode: "token", token },
        controlUi: { root: state.workspaceDir, allowedOrigins: [`http://127.0.0.1:${port}`] },
      },
      plugins: { enabled: false },
      agents: {
        ownership: "explicit",
        entries: {
          alpha: {
            workspace: state.workspaceDir,
            model: "fixture/first",
            modelPolicy: { allow: ["fixture/first"] },
          },
          bravo: {
            workspace: state.statePath("bravo"),
            model: "fixture/second",
            modelPolicy: { allow: ["fixture/second"] },
          },
        },
      },
      models: {
        catalogRefresh: { enabled: false },
        providers: {
          fixture: {
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:9/v1",
            apiKey: "synthetic-key",
            models: [
              { id: "first", name: "First model" },
              { id: "second", name: "Second model" },
            ],
          },
        },
      },
    },
    onEvent(event) {
      if (event.event === "models.snapshot") {
        publications.push(event.payload as ModelsSnapshotEvent);
        initialPublished.resolve();
      }
    },
  });
  try {
    // Authentication and healthy reads are usable while the model owner is still preparing.
    expect(publications).toEqual([]);
    await expect(client.request("sessions.list", {})).resolves.toMatchObject({
      sessions: expect.any(Array),
    });
    releaseInitialModels.resolve();
    await withinTest(initialPublished.promise, signal);
    expect(publications).toMatchObject(snapshot({ agentId: "alpha" }, [model("first")]));
    for (const selection of [
      { hint: "bravo", agentId: "bravo", modelId: "second" },
      { hint: "missing", agentId: "alpha", modelId: "first" },
    ]) {
      await using other = await connect({ modelCatalog: { agentId: selection.hint } });
      await expect
        .poll(() => other.snapshots)
        .toMatchObject(snapshot({ agentId: selection.agentId }, [model(selection.modelId)]));
      expect(publications).toHaveLength(1);
    }
    const sessionKey = "agent:alpha:dashboard:12345678-1234-4123-8123-123456789abc";
    await upsertSessionEntryCore(
      { agentId: "alpha", sessionKey },
      {
        sessionId: "saved-model-catalog-session",
        updatedAt: Date.now(),
        providerOverride: "fixture",
        modelOverride: "second",
        modelOverrideRouteResolution: "resolved",
        authProfileOverride: "fixture:saved-account",
        authProfileOverrideSource: "user",
      },
    );
    for (const modelCatalog of [
      { agentId: "alpha", sessionKey },
      { agentId: "alpha", shortId: "12345678", slugHint: "saved" },
    ]) {
      await using saved = await connect({
        modelCatalog,
        caps: ["model-selection-policy"],
      });
      // hello-ok precedes worker-backed catalog publication; join that event
      // instead of assuming preparation fits the polling matcher's deadline.
      await saved.published;
      expect(saved.snapshots[0]?.catalog.models).toHaveLength(2);
      expect(saved.snapshots).toMatchObject(
        snapshot(
          { agentId: "alpha", sessionKey },
          expect.arrayContaining([
            expect.objectContaining(model("first", true)),
            expect.objectContaining(model("second", false)),
          ]),
          {
            kind: "shared",
            authProfileId: "fixture:saved-account",
            source: "user",
          },
        ),
      );
      expect(publications).toHaveLength(1);
      expect(loadSessionEntry({ agentId: "alpha", sessionKey })?.modelOverride).toBe("second");
    }
    await client.request("sessions.patch", {
      key: sessionKey,
      agentId: "alpha",
      label: "Initial catalog publication race",
    });
    const publicationStarted = createDeferred();
    const releasePublication = createDeferred();
    const resolveReadParams = chatMetadataHandler.resolveChatMetadataReadParams;
    const holdNextPublication = (
      started: ReturnType<typeof createDeferred<void>>,
      release: ReturnType<typeof createDeferred<void>>,
    ) =>
      vi
        .spyOn(chatMetadataHandler, "resolveChatMetadataReadParams")
        .mockImplementationOnce(async (...args) => {
          const scope = await resolveReadParams(...args);
          if (!scope?.withCurrent) {
            throw new Error("Expected saved-session publication authority");
          }
          const withCurrent = scope.withCurrent;
          return {
            ...scope,
            withCurrent: async <T>(consume: () => T): Promise<Awaited<T>> => {
              started.resolve();
              await release.promise;
              return await withCurrent(consume);
            },
          };
        });
    // Cached projections still cross the live publication authority boundary.
    const publicationSpy = holdNextPublication(publicationStarted, releasePublication);
    const replacementAccount = { authProfileId: "fixture:replacement-account" };
    const sessionChanges: unknown[] = [];
    let racingClient: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      racingClient = await connect({
        modelCatalog: { agentId: "alpha", sessionKey },
        caps: ["model-selection-policy"],
        onEvent(event) {
          if (event.event === "sessions.changed") {
            sessionChanges.push(event.payload);
          }
        },
      });
      await withTestTimeout(
        publicationStarted.promise,
        10_000,
        "Initial catalog publication did not start",
      );
      await racingClient.request("sessions.subscribe", { agentId: "alpha" });
      await racingClient.request("sessions.patch", {
        key: sessionKey,
        agentId: "alpha",
        model: "fixture/first@fixture:replacement-account",
      });
      await expect
        .poll(() => sessionChanges)
        .toContainEqual(expect.objectContaining({ sessionKey, reason: "patch" }));
      await expect(
        racingClient.request("models.list", { agentId: "alpha", sessionKey }),
      ).resolves.toMatchObject({
        accountSelection: replacementAccount,
      });
      expect(racingClient.snapshots).toEqual([]);
      expect(getActiveGatewayRootWorkCount()).toBeGreaterThan(0);
      releasePublication.resolve();
      await expect.poll(() => getActiveGatewayRootWorkCount()).toBe(0);
      // A response on this same socket is a delivery barrier after initial work settles.
      await expect(
        racingClient.request("models.list", { agentId: "alpha", sessionKey }),
      ).resolves.toMatchObject({
        models: [model("first", true)],
        accountSelection: {
          ...replacementAccount,
          source: "user",
        },
      });
      for (const publication of racingClient.snapshots) {
        expect(publication.catalog.accountSelection).toMatchObject(replacementAccount);
      }
    } finally {
      releasePublication.resolve();
      publicationSpy.mockRestore();
      if (racingClient) {
        await disconnectGatewayClient(racingClient);
      }
    }
    const unrelatedKey = "agent:alpha:catalog-other";
    await upsertSessionEntryCore(
      { agentId: "alpha", sessionKey: unrelatedKey },
      { sessionId: "unrelated-catalog-session", updatedAt: Date.now() },
    );
    const requestEntered = createDeferred();
    const releaseRequest = createDeferred();
    const pendingPublication = holdNextPublication(requestEntered, releaseRequest);
    const pendingCatalog = client.request("models.list", { agentId: "alpha", sessionKey });
    const deliveredCatalog = expect(pendingCatalog).resolves.toMatchObject({
      models: [model("first")],
      accountSelection: replacementAccount,
    });
    try {
      await awaitGateBeforeSettlement(
        requestEntered.promise,
        pendingCatalog,
        "Catalog request settled before its authority check",
      );
      await client.request("sessions.patch", {
        key: unrelatedKey,
        agentId: "alpha",
        label: "Renamed unrelated session",
      });
      releaseRequest.resolve();
      await deliveredCatalog;
    } finally {
      releaseRequest.resolve();
      pendingPublication.mockRestore();
      await Promise.allSettled([pendingCatalog, deliveredCatalog]);
    }
    for (const clientName of [
      GATEWAY_CLIENT_IDS.CONTROL_UI,
      GATEWAY_CLIENT_IDS.CLI,
      GATEWAY_CLIENT_IDS.IOS_APP,
      GATEWAY_CLIENT_IDS.ANDROID_APP,
    ]) {
      await using old = await connect({ clientName });
      await expect(old.request("models.list", { agentId: "alpha" })).resolves.toMatchObject({
        models: [{ id: "first", provider: "fixture" }],
      });
      expect(old.snapshots).toEqual([]);
    }
  } finally {
    releaseInitialModels.resolve();
    await disconnectGatewayClient(client);
    await server.close({ reason: "catalog publication test complete" });
  }
}, 60_000);
