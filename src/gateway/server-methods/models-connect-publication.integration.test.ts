import { expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import type { ModelsSnapshotEvent } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  getActiveGatewayRootWorkCount,
  getActiveGatewayRootWorkHolders,
} from "../../process/gateway-work-admission.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as modelCatalogAuth from "../server-model-catalog-auth.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  getGatewayE2ePortBlock,
  startGatewayWithClient,
} from "../test-helpers.e2e.js";

// Optional startup prewarming must not compete with the catalog request drain.
vi.mock("../server-startup-context-cache-prewarm.js", () => ({
  scheduleContextCachePrewarm: () => ({ stop() {} }),
}));
vi.mock("../server-startup-handler-prewarm.js", () => ({
  scheduleGatewayHandlerPrewarm: () => ({ stop() {} }),
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
    scheduleGatewayPostReadyMaintenance: (
      ...args: Parameters<typeof actual.scheduleGatewayPostReadyMaintenance>
    ) => {
      const timer = actual.scheduleGatewayPostReadyMaintenance(...args);
      clearTimeout(timer);
      return timer;
    },
  };
});

it("connect negotiates snapshots and preserves draft and saved-session catalog scopes", async () => {
  const state = await createOpenClawTestState({
    label: "models-connect-publication",
    env: {
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    },
  });
  const port = await getGatewayE2ePortBlock();
  const token = "synthetic-catalog-gateway-token";
  const publications: ModelsSnapshotEvent[] = [];
  try {
    state.applyEnv();
    await state.writeAuthProfiles(
      {
        version: 1,
        profiles: {
          "fixture:saved-account": {
            type: "api_key",
            provider: "fixture",
            key: "synthetic-saved-account-key",
          },
          "fixture:replacement-account": {
            type: "api_key",
            provider: "fixture",
            key: "synthetic-replacement-account-key",
          },
        },
      },
      "alpha",
    );
    const { client, server } = await startGatewayWithClient({
      port,
      configPath: state.configPath,
      token,
      clientName: GATEWAY_CLIENT_IDS.CONTROL_UI,
      modelCatalog: {},
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      origin: `http://127.0.0.1:${port}`,
      scopes: ["operator.admin"],
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
        }
      },
    });
    try {
      await expect
        .poll(() => publications, { timeout: 15_000 })
        .toMatchObject([
          {
            scope: { agentId: "alpha" },
            catalog: { models: [{ id: "first", provider: "fixture", available: true }] },
          },
        ]);
      for (const selection of [
        { hint: "bravo", agentId: "bravo", modelId: "second" },
        { hint: "missing", agentId: "alpha", modelId: "first" },
      ]) {
        const otherPublications: ModelsSnapshotEvent[] = [];
        const other = await connectGatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token,
          clientName: GATEWAY_CLIENT_IDS.CONTROL_UI,
          modelCatalog: { agentId: selection.hint },
          mode: GATEWAY_CLIENT_MODES.WEBCHAT,
          origin: `http://127.0.0.1:${port}`,
          scopes: ["operator.admin"],
          onEvent(event) {
            if (event.event === "models.snapshot") {
              otherPublications.push(event.payload as ModelsSnapshotEvent);
            }
          },
        });
        try {
          await expect
            .poll(() => otherPublications)
            .toMatchObject([
              {
                scope: { agentId: selection.agentId },
                catalog: {
                  models: [{ id: selection.modelId, provider: "fixture", available: true }],
                },
              },
            ]);
          expect(publications).toHaveLength(1);
        } finally {
          await disconnectGatewayClient(other);
        }
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
        const savedPublications: ModelsSnapshotEvent[] = [];
        const saved = await connectGatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token,
          clientName: GATEWAY_CLIENT_IDS.CONTROL_UI,
          modelCatalog,
          caps: ["model-selection-policy"],
          mode: GATEWAY_CLIENT_MODES.WEBCHAT,
          origin: `http://127.0.0.1:${port}`,
          scopes: ["operator.admin"],
          onEvent(event) {
            if (event.event === "models.snapshot") {
              savedPublications.push(event.payload as ModelsSnapshotEvent);
            }
          },
        });
        try {
          await expect
            .poll(() => savedPublications)
            .toMatchObject([
              {
                scope: { agentId: "alpha", sessionKey },
                catalog: {
                  models: [
                    {
                      id: "first",
                      provider: "fixture",
                      available: true,
                      manualSelectionAllowed: true,
                    },
                    {
                      id: "second",
                      provider: "fixture",
                      available: true,
                      manualSelectionAllowed: false,
                    },
                  ],
                  accountSelection: {
                    kind: "shared",
                    authProfileId: "fixture:saved-account",
                    source: "user",
                  },
                },
              },
            ]);
          expect(publications).toHaveLength(1);
          expect(loadSessionEntry({ agentId: "alpha", sessionKey })?.modelOverride).toBe("second");
        } finally {
          await disconnectGatewayClient(saved);
        }
      }
      const acquisitionStarted = createDeferred();
      const releaseAcquisition = createDeferred();
      const readPreparedCatalog = modelCatalogAuth.readPreparedCatalog;
      let acquisitionSettled = false;
      const acquisition = vi
        .spyOn(modelCatalogAuth, "readPreparedCatalog")
        .mockImplementationOnce(async (...args) => {
          // The registered reader has captured the saved account before catalog acquisition.
          acquisitionStarted.resolve();
          await releaseAcquisition.promise;
          try {
            return await readPreparedCatalog(...args);
          } finally {
            acquisitionSettled = true;
          }
        });
      const racingPublications: ModelsSnapshotEvent[] = [];
      const sessionChanges: unknown[] = [];
      let racingClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
      try {
        racingClient = await connectGatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token,
          clientName: GATEWAY_CLIENT_IDS.CONTROL_UI,
          modelCatalog: { agentId: "alpha", sessionKey },
          caps: ["model-selection-policy"],
          mode: GATEWAY_CLIENT_MODES.WEBCHAT,
          origin: `http://127.0.0.1:${port}`,
          scopes: ["operator.admin"],
          onEvent(event) {
            if (event.event === "models.snapshot") {
              racingPublications.push(event.payload as ModelsSnapshotEvent);
            } else if (event.event === "sessions.changed") {
              sessionChanges.push(event.payload);
            }
          },
        });
        await withTestTimeout(
          acquisitionStarted.promise,
          10_000,
          "Initial catalog acquisition did not start",
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
          accountSelection: { authProfileId: "fixture:replacement-account" },
        });
        expect(racingPublications).toEqual([]);
        expect(getActiveGatewayRootWorkCount()).toBeGreaterThan(0);
        releaseAcquisition.resolve();
        try {
          await expect.poll(() => getActiveGatewayRootWorkCount()).toBe(0);
        } catch (error) {
          try {
            console.error("Model catalog root work did not settle", {
              acquisitionSettled,
              holders: getActiveGatewayRootWorkHolders(),
            });
          } catch {
            // Diagnostic failures must not replace the original assertion.
          }
          throw error;
        }
        // A response on this same socket is a delivery barrier after initial work settles.
        await expect(
          racingClient.request("models.list", { agentId: "alpha", sessionKey }),
        ).resolves.toMatchObject({
          models: [
            { id: "first", provider: "fixture", available: true, manualSelectionAllowed: true },
          ],
          accountSelection: {
            authProfileId: "fixture:replacement-account",
            source: "user",
          },
        });
        for (const publication of racingPublications) {
          expect(publication.catalog.accountSelection).toMatchObject({
            authProfileId: "fixture:replacement-account",
          });
        }
      } finally {
        releaseAcquisition.resolve();
        acquisition.mockRestore();
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
      const pendingAcquisition = vi
        .spyOn(modelCatalogAuth, "readPreparedCatalog")
        .mockImplementationOnce(async (...args) => {
          requestEntered.resolve();
          await releaseRequest.promise;
          return readPreparedCatalog(...args);
        });
      const pendingCatalog = client.request("models.list", { agentId: "alpha", sessionKey });
      const superseded = expect(pendingCatalog).rejects.toMatchObject({
        code: "UNAVAILABLE",
        retryable: true,
        retryAfterMs: 0,
      });
      try {
        await withTestTimeout(requestEntered.promise, 10_000, "Catalog request did not start");
        await client.request("sessions.patch", {
          key: unrelatedKey,
          agentId: "alpha",
          label: "Renamed unrelated session",
        });
        releaseRequest.resolve();
        await superseded;
        await expect(
          client.request("models.list", { agentId: "alpha", sessionKey }),
        ).resolves.toMatchObject({
          accountSelection: { authProfileId: "fixture:replacement-account" },
        });
      } finally {
        releaseRequest.resolve();
        pendingAcquisition.mockRestore();
        await Promise.allSettled([pendingCatalog, superseded]);
      }
      for (const clientName of [
        GATEWAY_CLIENT_IDS.CONTROL_UI,
        GATEWAY_CLIENT_IDS.CLI,
        GATEWAY_CLIENT_IDS.IOS_APP,
        GATEWAY_CLIENT_IDS.ANDROID_APP,
      ]) {
        const oldPublications: unknown[] = [];
        const old = await connectGatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token,
          clientName,
          mode: GATEWAY_CLIENT_MODES.WEBCHAT,
          origin: `http://127.0.0.1:${port}`,
          scopes: ["operator.admin"],
          onEvent(event) {
            if (event.event === "models.snapshot") {
              oldPublications.push(event.payload);
            }
          },
        });
        try {
          await expect(old.request("models.list", { agentId: "alpha" })).resolves.toMatchObject({
            models: [{ id: "first", provider: "fixture" }],
          });
          expect(oldPublications).toEqual([]);
        } finally {
          await disconnectGatewayClient(old);
        }
      }
    } finally {
      await disconnectGatewayClient(client);
      await server.close({ reason: "catalog publication test complete" });
    }
  } finally {
    await state.cleanup();
  }
}, 60_000);
