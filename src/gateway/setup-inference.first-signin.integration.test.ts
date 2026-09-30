import { afterEach, expect, it, vi } from "vitest";
import type { WizardNextResult } from "../../packages/gateway-protocol/src/index.js";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { resolveAgentEffectiveModelPrimary } from "../agents/agent-scope.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles/store-runtime.js";
import * as catalogRefresh from "../agents/prepared-model-runtime.refresh-scope.js";
import { getRuntimeConfig } from "../config/config.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { rotateDeviceToken } from "../infra/device-pairing-tokens.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import { onInternalDiagnosticEvent } from "../infra/diagnostic-events.js";
import { getCurrentDiagnosticPhase } from "../logging/diagnostic-phase.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resetGatewayTestState } from "./gateway.test-support.js";
import * as setupAdmission from "./server-methods/setup-admission.js";
import type { GatewayRequestOptions } from "./server-methods/types.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";

const observation = vi.hoisted(() => ({ settled: (_options: GatewayRequestOptions) => {} }));

// A revoked socket can lose its reply. Join the real handler before checking effects.
vi.mock(
  "./server/ws-connection/authenticated-request-dispatch.server-methods.runtime.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("./server/ws-connection/authenticated-request-dispatch.server-methods.runtime.js")
      >();
    return {
      ...actual,
      handleGatewayRequest: async (...args: Parameters<typeof actual.handleGatewayRequest>) => {
        const settled = observation.settled;
        try {
          return await actual.handleGatewayRequest(...args);
        } finally {
          settled(args[0]);
        }
      },
    };
  },
);

afterEach(() => {
  observation.settled = () => {};
  vi.restoreAllMocks();
  resetGatewayTestState();
});

it(
  "replaces same-owner device sign-in, preserves other owners, and fences revoked retries through WebSocket",
  { timeout: 90_000 },
  async ({ signal, onTestFinished }) => {
    const requests: string[] = [];
    const startedAt = performance.now();
    const observedPhases = new Set([
      "config.load",
      "config.normalize",
      "state.ownership",
      "state.schema-preflight",
      "worker-environments.store-import",
      "plugins.bootstrap-imports",
      "plugins.load",
      "startup.maintenance",
      "gateway.ready",
      "sidecars.model-runtime",
      "sidecars.reply-runtime",
      "sidecars.chat-metadata",
      "sidecars.total",
    ]);
    const ownerTimings: Array<{
      name: string;
      phase: string;
      elapsedMs: number;
      durationMs?: number;
      cpuTotalMs?: number;
      admissionMs?: number;
      queueWaitMs?: number;
    }> = [];
    // Keep only named timing facts: diagnostic details can contain private state.
    const stopObserving = onInternalDiagnosticEvent(
      (event) => {
        if (ownerTimings.length >= 64) {
          return;
        }
        const elapsedMs = Math.round(performance.now() - startedAt);
        if (event.type === "diagnostic.phase.completed" && observedPhases.has(event.name)) {
          ownerTimings.push({
            name: event.name,
            phase: "completed",
            elapsedMs,
            durationMs: event.durationMs,
            cpuTotalMs: event.cpuTotalMs,
          });
        } else if (
          event.type === "gateway.rpc" &&
          (event.method === "openclaw.setup.auth.start" || event.method === "wizard.next")
        ) {
          ownerTimings.push({
            name: event.method,
            phase: event.phase,
            elapsedMs,
            durationMs: event.phase === "received" ? undefined : event.durationMs,
            admissionMs: event.phase === "handler" ? event.admissionMs : undefined,
            queueWaitMs: event.phase === "dispatch" ? event.queueWaitMs : undefined,
          });
        }
      },
      { include: ["diagnostic.phase.completed", "gateway.rpc"] },
    );
    onTestFinished(stopObserving);
    const requestPhases = new Map([
      ["https://github.com/login/device/code", "device-code"],
      ["https://github.com/login/oauth/access_token", "access-token"],
      ["https://api.github.com/copilot_internal/user", "account"],
      ["https://api.individual.githubcopilot.com/models", "models"],
      ["https://api.individual.githubcopilot.com/v1/messages", "probe"],
      ["https://catalog.openclaw.ai/models/v2/catalog.json", "catalog-refresh"],
    ]);
    let lastRequestPhase: string | undefined;
    let lastRequestElapsedMs: number | undefined;
    let phase = "fixture-setup";
    const phaseTransitions = [{ phase, elapsedMs: 0 }];
    const markPhase = (nextPhase: string) => {
      phase = nextPhase;
      phaseTransitions.push({ phase, elapsedMs: Math.round(performance.now() - startedAt) });
    };
    let wizardSteps = 0;
    let wizardStepType: string | undefined;
    let wizardProgressPhase: "device-code" | "browser" | "testing" | "other" | undefined;
    let wizardProgressElapsedMs: number | undefined;
    const reportAbort = () => {
      const activePhase = getCurrentDiagnosticPhase();
      console.error("[setup-first-signin] test aborted", {
        pid: process.pid,
        activePhase: activePhase
          ? observedPhases.has(activePhase)
            ? activePhase
            : "other"
          : "none",
        ownerTimingLimitReached: ownerTimings.length === 64,
        ownerTimings,
        phase,
        elapsedMs: Math.round(performance.now() - startedAt),
        phaseTransitions,
        mockedRequests: requests.length,
        lastRequestPhase,
        lastRequestElapsedMs,
        deviceCodeRequests: requests.filter((url) => url === "https://github.com/login/device/code")
          .length,
        tokenRequests: requests.filter(
          (url) => url === "https://github.com/login/oauth/access_token",
        ).length,
        accountRequests: requests.filter(
          (url) => url === "https://api.github.com/copilot_internal/user",
        ).length,
        modelRequests: requests.filter(
          (url) => url === "https://api.individual.githubcopilot.com/models",
        ).length,
        probeRequests: requests.filter(
          (url) => url === "https://api.individual.githubcopilot.com/v1/messages",
        ).length,
        catalogRequests: requests.filter(
          (url) => url === "https://catalog.openclaw.ai/models/v2/catalog.json",
        ).length,
        wizardSteps,
        wizardStepType,
        wizardProgressPhase,
        wizardProgressElapsedMs,
      });
    };
    // Capture the deadline phase before teardown can advance the pending test.
    signal.addEventListener("abort", reportAbort, { once: true });
    onTestFinished(() => signal.removeEventListener("abort", reportAbort));
    // Inventory refresh runs in another thread; the setup probe owns this test's transport.
    vi.spyOn(catalogRefresh, "refreshCommittedProviderCatalogs").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      requests.push(`${url.origin}${url.pathname}`);
      lastRequestPhase = requestPhases.get(`${url.origin}${url.pathname}`) ?? "other";
      lastRequestElapsedMs = Math.round(performance.now() - startedAt);
      switch (`${url.origin}${url.pathname}`) {
        case "https://github.com/login/device/code":
          return Response.json({
            device_code: "synthetic-device-code",
            user_code: "TEST-CODE",
            verification_uri: "https://github.com/login/device",
            expires_in: 600,
            interval: 1,
          });
        case "https://github.com/login/oauth/access_token":
          return Response.json({
            access_token: "synthetic-device-token",
            token_type: "bearer",
            scope: "read:user",
          });
        case "https://api.github.com/copilot_internal/user":
          return Response.json({ endpoints: { api: "https://api.individual.githubcopilot.com" } });
        case "https://api.individual.githubcopilot.com/models":
          return Response.json({
            data: [
              {
                id: "claude-sonnet-5",
                name: "Synthetic chat model",
                object: "model",
                vendor: "Anthropic",
                model_picker_enabled: true,
                capabilities: {
                  type: "chat",
                  limits: { max_context_window_tokens: 128_000, max_output_tokens: 4096 },
                  supports: { tool_calls: true },
                },
              },
            ],
          });
        case "https://api.individual.githubcopilot.com/v1/messages": {
          const events = [
            {
              type: "message_start",
              message: {
                id: "synthetic-message",
                type: "message",
                role: "assistant",
                model: "claude-sonnet-5",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 5, output_tokens: 0 },
              },
            },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
            { type: "content_block_stop", index: 0 },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 1 },
            },
            { type: "message_stop" },
          ];
          return new Response(
            events
              .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
              .join(""),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        default:
          throw new Error(`Unexpected setup request: ${url.origin}${url.pathname}`);
      }
    });
    await withOpenClawTestState(
      {
        label: "setup-first-signin",
        env: {
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_DISABLE_BONJOUR: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          COPILOT_GITHUB_TOKEN: undefined,
        },
      },
      async (state) => {
        const recoveryRestart = vi.fn(() => {
          throw new Error("Setup must complete without a recovery restart");
        });
        markPhase("gateway-start-and-connect");
        const { client, server, port } = await startGatewayWithClient({
          configPath: state.configPath,
          token: "synthetic-gateway-token",
          scopes: ["operator.admin"],
          hotReloadRecovery: recoveryRestart,
          cfg: {
            gateway: {
              mode: "local",
              auth: { mode: "token", token: "synthetic-gateway-token" },
            },
            agents: { defaults: { workspace: state.workspaceDir, skipBootstrap: true } },
            plugins: {
              allow: ["github-copilot"],
              slots: { memory: "none" },
              entries: { "github-copilot": { enabled: true } },
            },
            cron: { enabled: false },
            update: { checkOnStart: false },
          },
        });
        let owner: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
        try {
          markPhase("gateway-startup-settlement");
          await server.startupSettled;
          const identity = loadOrCreateDeviceIdentity({ path: state.path("setup-owner.sqlite") });
          const pending = await requestDevicePairing({
            deviceId: identity.deviceId,
            publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
            clientId: "test",
            clientMode: "backend",
            role: "operator",
            scopes: ["operator.admin"],
          });
          await approveDevicePairing(pending.request.requestId, {
            callerScopes: ["operator.admin"],
          });
          const rotated = await rotateDeviceToken({
            deviceId: identity.deviceId,
            role: "operator",
            scopes: ["operator.admin"],
          });
          if (!rotated.ok) {
            throw new Error("Expected setup owner device token");
          }
          // Backend clients keep device ownership; the admin client uses the Gateway owner profile.
          owner = await connectGatewayClient({
            mode: "backend",
            url: `ws://127.0.0.1:${port}`,
            deviceIdentity: identity,
            deviceToken: rotated.entry.token,
            scopes: ["operator.admin"],
          });
          const auth = {
            agentId: "main",
            authChoice: "github-copilot",
            nativeSessionCatalogsEnabled: false,
          };
          const readProfiles = () =>
            loadAuthProfileStoreWithoutExternalProfiles(state.agentDir()).profiles;
          markPhase("different-owner-rejected");
          await owner.request("openclaw.setup.auth.start", {
            ...auth,
            sessionId: "abandoned-signin",
          });
          const abandoned = await owner.request<WizardNextResult>("wizard.next", {
            sessionId: "abandoned-signin",
          });
          expect(abandoned).toMatchObject({ done: false, step: { type: "note" } });
          await expect(
            client.request("openclaw.setup.auth.start", { ...auth, sessionId: "different-owner" }),
          ).rejects.toThrow("OpenClaw setup is already in progress");
          expect(await owner.request("wizard.next", { sessionId: "abandoned-signin" })).toEqual(
            abandoned,
          );
          expect(readProfiles()).toEqual({});

          const sessionId = "replacement-signin";
          markPhase("same-owner-retry");
          await owner.request("openclaw.setup.auth.start", { ...auth, sessionId });
          markPhase("wizard-next");
          let result = await owner.request<WizardNextResult>("wizard.next", { sessionId });
          while (!result.done) {
            const step = result.step;
            if (!step) {
              throw new Error("Setup wizard did not return a step");
            }
            wizardSteps += 1;
            wizardStepType = step.type;
            wizardProgressPhase = undefined;
            wizardProgressElapsedMs = undefined;
            if (step.type === "progress") {
              // Later progress retains the device-code presentation as a prefix.
              wizardProgressPhase = step.message?.endsWith("Testing your AI connection…")
                ? "testing"
                : step.message?.endsWith("Complete sign-in in your browser.")
                  ? "browser"
                  : step.deviceCode
                    ? "device-code"
                    : "other";
              wizardProgressElapsedMs = Math.round(performance.now() - startedAt);
            }
            result = await owner.request<WizardNextResult>("wizard.next", {
              sessionId,
              answer: { stepId: step.id, value: step.type === "confirm" ? true : null },
            });
          }
          markPhase("activation-assertions");
          expect(result, JSON.stringify(result)).toMatchObject({
            status: "done",
            modelActivation: { modelRef: "github-copilot/claude-sonnet-5" },
          });
          expect(
            requests.filter((url) => url === "https://github.com/login/oauth/access_token"),
          ).toHaveLength(1);
          expect(
            requests.filter(
              (url) => url === "https://api.individual.githubcopilot.com/v1/messages",
            ),
          ).toHaveLength(1);
          const savedProfiles = readProfiles();
          const profiles = Object.entries(savedProfiles);
          expect(profiles).toHaveLength(1);
          const [profileId, credential] = profiles[0]!;
          expect(credential).toMatchObject({
            type: "token",
            provider: "github-copilot",
            tokenRef: { source: "store" },
          });
          expect(credential).not.toHaveProperty("setup");
          expect(recoveryRestart).not.toHaveBeenCalled();
          expect(resolveAgentEffectiveModelPrimary(getRuntimeConfig(), "main")).toBe(
            `github-copilot/claude-sonnet-5@${profileId}`,
          );

          markPhase("queued-retry-revocation");
          await owner.request("openclaw.setup.auth.start", {
            ...auth,
            sessionId: "before-revocation",
          });
          let waiting = await owner.request<WizardNextResult>("wizard.next", {
            sessionId: "before-revocation",
          });
          expect(waiting.step?.type).toBe("confirm");
          waiting = await owner.request<WizardNextResult>("wizard.next", {
            sessionId: "before-revocation",
            answer: { stepId: waiting.step!.id, value: true },
          });
          expect(waiting).toMatchObject({ done: false, step: { type: "note" } });
          const beforeRevocation = [...requests];
          const reached = createDeferredCore();
          const release = createDeferredCore();
          const finished = createDeferredCore<string[]>();
          const whenSettled = setupAdmission.whenAdmittedWizardSessionSettled;
          // Hold only the retry's existing settlement await; cancellation and lock release stay real.
          vi.spyOn(setupAdmission, "whenAdmittedWizardSessionSettled").mockImplementationOnce(
            async (session) => {
              await whenSettled(session);
              reached.resolve();
              await release.promise;
            },
          );
          observation.settled = (options) => {
            if (options.req.method === "openclaw.setup.auth.start") {
              finished.resolve([...options.context.wizardSessions.keys()]);
            }
          };
          const reply = owner
            .request("openclaw.setup.auth.start", { ...auth, sessionId: "revoked-retry" })
            .then(
              (value) => ({ result: value }),
              (error: unknown) => ({ error }),
            );
          try {
            await withinTest(
              awaitGateBeforeSettlement(
                reached.promise,
                finished.promise,
                "Retry finished before settlement barrier",
              ),
              signal,
            );
            await client.request("device.token.revoke", {
              deviceId: identity.deviceId,
              role: "operator",
            });
            release.resolve();
            const sessions = await withinTest(finished.promise, signal);
            expect(await reply).toHaveProperty("error");
            expect(sessions).not.toContain("revoked-retry");
            expect(requests).toEqual(beforeRevocation);
            expect(readProfiles()).toEqual(savedProfiles);
            expect(resolveAgentEffectiveModelPrimary(getRuntimeConfig(), "main")).toBe(
              `github-copilot/claude-sonnet-5@${profileId}`,
            );
            expect(recoveryRestart).not.toHaveBeenCalled();
            markPhase("revoked-retry-no-effects");
          } finally {
            release.resolve();
            await withinTest(Promise.all([finished.promise, reply]), signal);
          }
          console.info("[setup-retry-proof]", {
            differentOwner: "rejected; original prompt preserved",
            sameOwner: "replacement activated",
            tokenExchanges: requests.filter(
              (url) => url === "https://github.com/login/oauth/access_token",
            ).length,
            storedProfiles: profiles.length,
            revokedRetry: "handler settled; no session, provider request, or credential change",
            phaseTransitions,
          });
        } finally {
          markPhase("client-disconnect");
          if (owner) {
            await disconnectGatewayClient(owner);
          }
          await disconnectGatewayClient(client);
          markPhase("server-close");
          await server.close({ reason: "first sign-in test complete" });
          markPhase("fixture-drain");
        }
      },
    );
  },
);
