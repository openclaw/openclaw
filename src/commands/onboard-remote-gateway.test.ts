import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type {
  SystemAgentSetupActivateStartParams,
  WizardNextParams,
} from "../../packages/gateway-protocol/src/index.js";
import type { HelloOk } from "../../packages/gateway-protocol/src/schema/frames.js";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CallGatewayCliOptions } from "../gateway/call.js";
import { loadOrCreateDeviceIdentityAsync } from "../infra/device-identity-async.js";
import type { RuntimeEnv } from "../runtime.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import { WizardSession } from "../wizard/session.js";
import { runRemoteGatewayInferenceOnboarding } from "./onboard-remote-gateway.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn<typeof import("../gateway/call.js").callGatewayCli>(),
  createPrompter: vi.fn<typeof import("../wizard/clack-prompter.js").createClackPrompter>(),
  runGuidedOnboarding: vi.fn<typeof import("./onboard-guided.js").runGuidedOnboarding>(),
  runTui: vi.fn<typeof import("../tui/tui.js").runTui>(),
}));

vi.mock("../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/call.js")>()),
  callGatewayCli: mocks.callGateway,
}));
vi.mock("../wizard/clack-prompter.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../wizard/clack-prompter.js")>()),
  createClackPrompter: mocks.createPrompter,
}));
// mock-isolation: Exercise remote RPC adapters without initializing the local setup and config owners.
vi.mock("./onboard-guided.js", () => ({ runGuidedOnboarding: mocks.runGuidedOnboarding }));
// mock-isolation: Remote onboarding records its handoff without loading the local terminal runtime.
vi.mock("../tui/tui.js", () => ({ runTui: mocks.runTui }));

vi.mock("../infra/device-identity-async.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/device-identity-async.js")>()),
  loadOrCreateDeviceIdentityAsync: vi.fn(async () => ({
    deviceId: "remote-onboarding-device",
    publicKeyPem: "test-public-key",
    privateKeyPem: "test-private-key",
  })),
}));

type RemoteGatewayInferenceTarget = Parameters<typeof runRemoteGatewayInferenceOnboarding>[0];
type GatewayCall = typeof import("../gateway/call.js").callGatewayCli;
type RunGuidedOnboarding = typeof import("./onboard-guided.js").runGuidedOnboarding;

function runWithGatewayMocks(dependencies: {
  callGateway: GatewayCall;
  target?: RemoteGatewayInferenceTarget;
  runtime?: RuntimeEnv;
  createPrompter?: typeof import("../wizard/clack-prompter.js").createClackPrompter;
  runGuidedOnboarding?: RunGuidedOnboarding;
  runTui?: typeof import("../tui/tui.js").runTui;
}) {
  mocks.callGateway.mockImplementation(dependencies.callGateway);
  mocks.createPrompter.mockImplementation(
    dependencies.createPrompter ?? (() => createWizardPrompter()),
  );
  mocks.runGuidedOnboarding.mockImplementation(
    dependencies.runGuidedOnboarding ?? exerciseGuidedAdapters(),
  );
  mocks.runTui.mockReset();
  if (dependencies.runTui) {
    mocks.runTui.mockImplementation(dependencies.runTui);
  }
  return runRemoteGatewayInferenceOnboarding(
    dependencies.target ?? makeTarget(),
    dependencies.runtime ?? makeRuntime(),
  );
}

function makeRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn() as unknown as RuntimeEnv["exit"],
  };
}

function makeLocalConfig(): OpenClawConfig {
  return {
    wizard: { securityAcknowledgedAt: "2026-07-11T00:00:00.000Z" },
    agents: {
      defaults: {
        workspace: "/client/workspace",
        model: { primary: "openai/local-only" },
      },
    },
    gateway: {
      mode: "remote",
      remote: { url: "wss://configured.example/ws", token: "configured-token" },
    },
  };
}

function makeTarget(
  config: OpenClawConfig = makeLocalConfig(),
  auth: { token?: string; password?: string } = { token: "selected-token" },
): RemoteGatewayInferenceTarget {
  return {
    config,
    gatewayUrl: "wss://selected.example/ws",
    ...auth,
    tlsFingerprint: "sha256:selected",
  };
}

function detectResult() {
  return {
    candidates: [
      {
        kind: "claude-cli",
        brandId: "claude",
        label: "Claude Code",
        detail: "logged in",
        modelRef: "claude-cli/opus",
        recommended: true,
        credentials: true,
      },
      {
        kind: "codex-cli",
        brandId: "openai",
        label: "Codex",
        detail: "logged in",
        modelRef: "openai/gpt-5.5",
        recommended: false,
        credentials: true,
      },
    ],
    unavailableCandidates: [
      {
        id: "antigravity-cli",
        label: "Antigravity CLI",
        detail: "installed",
        reason: "tool-free probe unavailable",
      },
    ],
    manualProviders: [],
    authOptions: [],
    recommendedInstalls: [],
    workspace: "/gateway/workspace",
    setupComplete: false,
  } as const;
}

function exerciseGuidedAdapters(): RunGuidedOnboarding {
  const run: RunGuidedOnboarding = async (_opts, runtime, deps) => {
    const detect = expectDefined(deps?.detect, "remote detection adapter");
    const activate = expectDefined(deps?.activate, "remote activation adapter");
    const chat = expectDefined(deps?.runSystemAgentChat, "remote chat adapter");
    const detection = await detect();
    expect(detection.unavailableCandidates[0]?.id).toBe("antigravity-cli");
    expect(detection.prepareOptions).toBeUndefined();
    const selected = expectDefined(detection.candidates[0], "remote candidate");
    expect(selected.brandId).toBe("claude");
    const activation = await activate({
      kind: selected.kind,
      modelRef: selected.modelRef,
      // The adapter must replace this client-side context with Gateway detection.workspace.
      workspace: "/client/workspace",
      surface: "cli",
      runtime,
    });
    if (activation.ok) {
      await chat("/client/workspace", runtime, true);
    }
  };
  return vi.fn(run);
}

function gatewayHello(bootId?: string): HelloOk {
  return {
    type: "hello-ok",
    protocol: 1,
    server: { version: "test", connId: "test-connection", ...(bootId ? { bootId } : {}) },
    features: { methods: [], events: [] },
    snapshot: { presence: [], health: {}, stateVersion: { presence: 0, health: 0 }, uptimeMs: 0 },
    auth: { role: "operator", scopes: [] },
    policy: { maxPayload: 1, maxBufferedBytes: 1, tickIntervalMs: 1 },
  };
}

function asGatewayCall(mock: ReturnType<typeof vi.fn>): GatewayCall {
  return mock as unknown as GatewayCall;
}

function setupReply(options: CallGatewayCliOptions, modelRef = "claude-cli/opus", restart = false) {
  switch (options.method) {
    case "openclaw.setup.detect":
      return detectResult();
    case "openclaw.setup.activate.start":
      return {
        sessionId: (options.params as { sessionId: string }).sessionId,
        done: false,
        status: "running",
      };
    case "wizard.next":
      return {
        done: true,
        status: "done",
        modelActivation: { modelRef, ...(restart ? { gatewayRestartRequired: true } : {}) },
      };
    case "openclaw.setup.verify":
      return { ok: true, modelRef, latencyMs: 100 };
    default:
      throw new Error(`unexpected Gateway method ${options.method}`);
  }
}

const activateCodex: RunGuidedOnboarding = async (_opts, runtime, deps) => {
  const detection = await deps?.detect?.();
  const candidate = expectDefined(
    detection?.candidates.find((entry) => entry.kind === "codex-cli"),
    "Codex candidate",
  );
  const activation = await deps?.activate?.({
    kind: "codex-cli",
    modelRef: candidate.modelRef,
    surface: "cli",
    runtime,
  });
  expect(activation).toMatchObject({ ok: true, gatewayRestartRequired: true });
};

const activationMethods = ["openclaw.setup.detect", "openclaw.setup.activate.start", "wizard.next"];

describe("runRemoteGatewayInferenceOnboarding", () => {
  it("preserves utility role through remote setup and rejects role drift", async () => {
    const call = vi.fn(async (options: CallGatewayCliOptions) => {
      if (options.method === "openclaw.setup.detect") {
        return {
          ...detectResult(),
          candidates: [
            {
              kind: "provider-auto:fixture",
              label: "Utility",
              detail: "Setup",
              modelRef: "fixture/small",
              modelTarget: "utility",
              recommended: false,
            },
          ],
          setupModel: "fixture/small",
          utilityModel: "fixture/small",
        };
      }
      if (options.method === "openclaw.setup.activate.start") {
        expect(options.params).toMatchObject({
          modelTarget: "utility",
          modelRef: "fixture/small",
        });
        return {
          sessionId: "fixture-session",
          done: true,
          status: "done",
          modelActivation: { modelRef: "fixture/small", modelTarget: "utility" },
        };
      }
      if (options.method === "openclaw.setup.verify") {
        expect(options.params).toEqual({ modelTarget: "utility" });
        return {
          ok: true,
          modelRef: "fixture/small",
          latencyMs: 10,
        };
      }
      throw new Error(`Unexpected request: ${options.method}`);
    });
    const work = runWithGatewayMocks({
      target: makeTarget(makeLocalConfig(), { token: "synthetic-token" }),
      callGateway: asGatewayCall(call),
      runGuidedOnboarding: async (_options, runtime, deps) => {
        const detection = await deps?.detect?.();
        expect(detection).toMatchObject({
          setupComplete: false,
          setupModel: "fixture/small",
          utilityModel: "fixture/small",
        });
        const choice = detection?.candidates[0];
        expect(choice?.modelTarget).toBe("utility");
        const result = await deps?.activate?.({
          kind: "provider-auto:fixture",
          modelRef: "fixture/small",
          modelTarget: choice?.modelTarget,
          surface: "cli",
          runtime,
        });
        expect(result).toMatchObject({
          ok: true,
          modelTarget: "utility",
          modelRef: "fixture/small",
        });
      },
    });
    await expect(work).rejects.toThrow("different model role");
  });

  it.each(["accept", "decline", "cancel"] as const)(
    "relays saved replacement confirmation through the Gateway wizard: %s",
    async (choice) => {
      let session: WizardSession | undefined;
      let sessionId: string | undefined;
      let activeKey = "working-key";
      const savedKey = "replacement-key";
      const confirmation = "Connection verified. Activate this saved sign-in?";
      const callGatewayMock = vi.fn(async (options: CallGatewayCliOptions): Promise<unknown> => {
        if (options.method === "openclaw.setup.activate.start") {
          const input = options.params as SystemAgentSetupActivateStartParams;
          sessionId = input.sessionId;
          expect(input.kind).toBe("saved-auth:openai:setup-replacement");
          session = new WizardSession(async (prompter, _signal, runnerSession) => {
            await prompter.note("Connection verified.");
            const accepted = await prompter.confirm({ message: confirmation, initialValue: false });
            if (!accepted) {
              runnerSession.setActivationRejection({
                disposition: "rejected-before-promotion",
                status: "unavailable",
              });
              throw new Error("Activation declined. Your current connection is unchanged.");
            }
            activeKey = savedKey;
            runnerSession.setModelActivation({ modelRef: "openai/gpt-5.5" });
          });
          return { sessionId, done: false, status: "running" };
        }
        if (options.method === "wizard.next") {
          const input = options.params as WizardNextParams;
          expect(input.sessionId).toBe(sessionId);
          const running = expectDefined(session, "activation session");
          if (input.answer) {
            await running.answer(input.answer.stepId, input.answer.value);
          }
          const result = await running.next();
          if (result.done) {
            await running.whenSettled();
          }
          return result;
        }
        if (options.method === "wizard.cancel") {
          expect(options.params).toEqual({ sessionId, closeInput: true });
          const running = expectDefined(session, "activation session");
          running.close(new WizardCancelledError("cancelled"));
          await running.whenSettled();
          return { status: running.getStatus() };
        }
        if (options.method === "openclaw.setup.verify") {
          expect(activeKey).toBe(savedKey);
          return { ok: true, modelRef: "openai/gpt-5.5", latencyMs: 100 };
        }
        throw new Error(`unexpected Gateway method ${options.method}`);
      });
      const prompter = createWizardPrompter({
        confirm: vi.fn(async () => {
          if (choice === "cancel") {
            throw new WizardCancelledError("cancelled");
          }
          return choice === "accept";
        }),
      });
      const runGuidedOnboarding: RunGuidedOnboarding = async (_opts, runtime, deps) => {
        const activate = expectDefined(deps?.activate, "remote activation adapter");
        const result = await activate({
          kind: "saved-auth:openai:setup-replacement",
          modelRef: "openai/gpt-5.5",
          surface: "cli",
          runtime,
          prompter,
        });
        expect(result).toMatchObject(
          choice === "accept"
            ? { ok: true, modelRef: "openai/gpt-5.5" }
            : { ok: false, status: "unavailable" },
        );
      };
      const onboarding = runWithGatewayMocks({
        callGateway: asGatewayCall(callGatewayMock),
        runGuidedOnboarding,
      });
      if (choice === "cancel") {
        await expect(onboarding).rejects.toThrow("cancelled");
      } else {
        await onboarding;
      }
      expect(prompter.confirm).toHaveBeenCalledWith({ message: confirmation, initialValue: false });
      expect(activeKey).toBe(choice === "accept" ? savedKey : "working-key");
      expect(
        callGatewayMock.mock.calls.filter(
          ([options]) => options.method === "openclaw.setup.verify",
        ),
      ).toHaveLength(choice === "accept" ? 1 : 0);
      expect(expectDefined(session, "activation session").isSettled()).toBe(true);
    },
  );

  it.each([
    {
      label: "password",
      auth: { password: "selected-password" },
      secret: "selected-password",
      configuredRemote: false,
    },
    {
      label: "configured SSH token",
      auth: { token: "selected-token" },
      secret: "selected-token",
      configuredRemote: true,
    },
  ])(
    "pins $label across detect, activate, verify, OpenClaw, and in-process TUI",
    async ({ auth, secret, configuredRemote }) => {
      const localConfig = makeLocalConfig();
      const gatewayUrl = configuredRemote ? "ws://127.0.0.1:18789" : "wss://selected.example/ws";
      if (configuredRemote) {
        localConfig.gateway = {
          ...localConfig.gateway,
          remote: { url: gatewayUrl, transport: "ssh", sshTarget: "me@studio", remotePort: 18789 },
        };
      }
      const localConfigBefore = structuredClone(localConfig);
      const order: string[] = [];
      const remoteConfig: { modelRef?: string } = {};
      const callGatewayMock = vi.fn(async (options: CallGatewayCliOptions): Promise<unknown> => {
        expect(options.url).toBe(configuredRemote ? undefined : gatewayUrl);
        expect(options.token).toBe(auth.token);
        expect(options.password).toBe(auth.password);
        expect(options.tlsFingerprint).toBe("sha256:selected");
        expect(options.ignoreEnvUrlOverride).toBe(true);
        expect(options.config?.gateway?.remote?.url).toBe(gatewayUrl);
        expect(options.config?.gateway?.remote?.transport).toBe(
          configuredRemote ? "ssh" : "direct",
        );
        order.push(options.method);

        if (options.method === "openclaw.setup.detect") {
          expect(options.timeoutMs).toBe(40_000);
          return detectResult();
        }
        if (options.method === "openclaw.setup.activate.start") {
          expect(options.timeoutMs).toBe(150_000);
          expect(options.params).toEqual({
            sessionId: expect.any(String),
            kind: "claude-cli",
            modelRef: "claude-cli/opus",
            workspace: "/gateway/workspace",
          });
          return {
            sessionId: (options.params as { sessionId: string }).sessionId,
            done: false,
            status: "running",
          };
        }
        if (options.method === "wizard.next") {
          remoteConfig.modelRef = "claude-cli/opus";
          return {
            done: true,
            status: "done",
            modelActivation: { modelRef: remoteConfig.modelRef },
          };
        }
        if (options.method === "openclaw.setup.verify") {
          expect(options.timeoutMs).toBe(30_000);
          expect(remoteConfig.modelRef).toBe("claude-cli/opus");
          return { ok: true, modelRef: remoteConfig.modelRef, latencyMs: 100 };
        }
        if (options.method === "openclaw.chat") {
          expect(options.timeoutMs).toBe(190_000);
          expect(remoteConfig.modelRef).toBe("claude-cli/opus");
          expect(options.params).toEqual({
            sessionId: expect.any(String),
            welcomeVariant: "onboarding",
          });
          return {
            sessionId: (options.params as { sessionId: string }).sessionId,
            reply: "Inference is ready. I can configure the rest.",
            action: "open-agent",
            agentDraft: "hatch",
          };
        }
        throw new Error(`unexpected Gateway method ${options.method}`);
      });
      const runTui = vi.fn(async (options: Record<string, unknown>) => {
        order.push("tui");
        expect(options).toEqual({
          config: expect.objectContaining({
            gateway: expect.objectContaining({
              remote: expect.objectContaining({ url: gatewayUrl }),
            }),
          }),
          deliver: false,
          message: "Wake up, my friend!",
          boundGateway: {
            url: gatewayUrl,
            ...(configuredRemote ? { configuredRemote: true } : {}),
            ...auth,
            tlsFingerprint: "sha256:selected",
          },
        });
        return { exitReason: "exit" as const };
      });
      const text = vi.fn(async () => "unexpected");
      const prompter = createWizardPrompter({ text });
      const runtime = makeRuntime();

      await runWithGatewayMocks({
        target: { ...makeTarget(localConfig, auth), gatewayUrl, configuredRemote },
        runtime,
        callGateway: asGatewayCall(callGatewayMock),
        createPrompter: () => prompter,
        runTui,
      });

      expect(order).toEqual([
        ...activationMethods,
        "openclaw.setup.verify",
        "openclaw.chat",
        "tui",
      ]);
      expect(remoteConfig.modelRef).toBe("claude-cli/opus");
      expect(localConfig).toEqual(localConfigBefore);
      expect(text).not.toHaveBeenCalled();
      expect(process.argv).not.toContain(secret);
      expect(
        JSON.stringify([prompter.note, prompter.outro, runtime.log, runtime.error]),
      ).not.toContain(secret);
    },
  );

  it.each([
    {
      label: "request rejection",
      firstVerification: () =>
        Promise.reject(
          Object.assign(new Error("gateway restarting"), {
            name: "GatewayClientRequestError",
            gatewayCode: "UNAVAILABLE",
            retryable: true,
            retryAfterMs: 0,
          }),
        ),
    },
    {
      label: "typed unavailable result",
      firstVerification: () =>
        Promise.resolve({ ok: false, status: "unavailable", error: "gateway restarting" }),
    },
  ])("waits for a declared Gateway restart after $label", async ({ firstVerification }) => {
    const methods: string[] = [];
    let verifyAttempts = 0;
    const callGatewayMock = vi.fn(async (options: CallGatewayCliOptions): Promise<unknown> => {
      options.onHelloOk?.(
        gatewayHello(options.method === "openclaw.setup.verify" ? "new-boot" : "old-boot"),
      );
      options.signal?.throwIfAborted();
      methods.push(options.method);
      if (options.method === "openclaw.setup.verify" && verifyAttempts++ === 0) {
        return await firstVerification();
      }
      return setupReply(options, "openai/gpt-5.5", true);
    });

    await runWithGatewayMocks({
      callGateway: asGatewayCall(callGatewayMock),
      runGuidedOnboarding: activateCodex,
    });

    expect(methods).toEqual([
      ...activationMethods,
      "openclaw.setup.verify",
      "openclaw.setup.verify",
    ]);
  });

  it.for([
    "replacement",
    "missing activation identity",
    "missing verification identity",
    "restart timeout",
  ])("gates inference and chat on replacement boot: %s", async (mode, ctx) => {
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    ctx.onTestFinished(() => now.mockRestore());
    const sent: string[] = [];
    const verifiedBoots: string[] = [];
    let verificationConnections = 0;
    let bootId: string | undefined = "old-boot";
    const callGatewayMock = vi.fn(async (options: CallGatewayCliOptions): Promise<unknown> => {
      if (
        options.method === "openclaw.setup.activate.start" &&
        mode === "missing activation identity"
      ) {
        bootId = undefined;
      }
      if (options.method === "openclaw.setup.verify") {
        if (mode === "restart timeout") {
          now.mockReturnValue(45_000);
        } else if (verificationConnections++ > 0) {
          bootId = mode === "missing verification identity" ? undefined : "new-boot";
        }
      }
      options.onHelloOk?.(gatewayHello(bootId));
      options.signal?.throwIfAborted();
      sent.push(options.method);
      if (options.method === "openclaw.setup.verify") {
        verifiedBoots.push(bootId ?? "unidentified");
        return { ok: true, modelRef: "claude-cli/opus", latencyMs: 100 };
      }
      if (options.method === "openclaw.chat") {
        expect(bootId).toBe("new-boot");
        return { sessionId: "test-session", reply: "Ready.", action: "exit" };
      }
      return setupReply(options, "claude-cli/opus", true);
    });

    const onboarding = runWithGatewayMocks({
      callGateway: asGatewayCall(callGatewayMock),
    });
    if (mode !== "replacement") {
      await expect(onboarding).rejects.toThrow(
        mode === "restart timeout"
          ? "Inference settings were saved, but the Gateway did not finish restarting"
          : "Inference settings were saved, but the Gateway did not provide a boot identity",
      );
      expect(verifiedBoots).toEqual([]);
      expect(sent).toEqual([...activationMethods]);
      return;
    }
    await onboarding;
    expect(verifiedBoots).toEqual(["new-boot"]);
    expect(sent).toEqual([...activationMethods, "openclaw.setup.verify", "openclaw.chat"]);
  });

  it("bounds a late restart verification call by the remaining deadline", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(45_500).mockReturnValueOnce(1_000);
    // Wall clock jumps backward 90s -- must not inflate the monotonic remaining budget.
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(-90_000);
    const callGatewayMock = vi.fn(async (options: CallGatewayCliOptions): Promise<unknown> => {
      options.onHelloOk?.(
        gatewayHello(options.method === "openclaw.setup.verify" ? "new-boot" : "old-boot"),
      );
      options.signal?.throwIfAborted();
      return setupReply(options, "openai/gpt-5.5", true);
    });

    try {
      await runWithGatewayMocks({
        callGateway: asGatewayCall(callGatewayMock),
        runGuidedOnboarding: activateCodex,
      });
    } finally {
      now.mockRestore();
      dateNow.mockRestore();
    }

    // remaining = 45_000 - 44_500 = 500 (monotonic, despite Date.now at -90_000)
    expect(
      callGatewayMock.mock.calls.find(
        ([options]) => options.method === "openclaw.setup.verify",
      )?.[0].timeoutMs,
    ).toBe(500);
  });
  it("hands an auth-free Gateway to the TUI as the exact bound route", async () => {
    const callGatewayMock = vi.fn(async (options: CallGatewayCliOptions): Promise<unknown> => {
      if (options.method === "openclaw.chat") {
        return {
          sessionId: (options.params as { sessionId: string }).sessionId,
          reply: "Ready.",
          action: "open-agent",
        };
      }
      return setupReply(options);
    });
    const runTui = vi.fn(async () => ({ exitReason: "exit" as const }));

    await runWithGatewayMocks({
      target: makeTarget(makeLocalConfig(), {}),
      callGateway: asGatewayCall(callGatewayMock),
      runTui,
    });

    expect(runTui).toHaveBeenCalledWith({
      config: expect.objectContaining({
        gateway: expect.objectContaining({
          remote: expect.objectContaining({ url: "wss://selected.example/ws" }),
        }),
      }),
      deliver: false,
      boundGateway: {
        url: "wss://selected.example/ws",
        tlsFingerprint: "sha256:selected",
      },
    });
  });

  it.each([
    {
      label: "failed verification",
      verification: { ok: false, status: "auth", error: "credential expired" },
      error: "Gateway inference verification failed: credential expired",
    },
    {
      label: "mismatched model",
      verification: { ok: true, modelRef: "openai/other", latencyMs: 100 },
      error: "Gateway verified openai/other, not the activated claude-cli/opus",
    },
  ])("fails closed on $label before OpenClaw", async ({ verification, error }) => {
    const localConfig = makeLocalConfig();
    const localConfigBefore = structuredClone(localConfig);
    const methods: string[] = [];
    const callGatewayMock = vi.fn(async (options: CallGatewayCliOptions): Promise<unknown> => {
      methods.push(options.method);
      if (options.method === "openclaw.setup.verify") {
        return verification;
      }
      return setupReply(options);
    });
    const runTui = vi.fn();

    await expect(
      runWithGatewayMocks({
        target: makeTarget(localConfig),
        callGateway: asGatewayCall(callGatewayMock),
        runTui,
      }),
    ).rejects.toThrow(error);

    expect(methods).toEqual([...activationMethods, "openclaw.setup.verify"]);
    expect(runTui).not.toHaveBeenCalled();
    expect(localConfig).toEqual(localConfigBefore);
  });

  it("does not advance or fall back locally after an ambiguous activation request failure", async () => {
    const methods: string[] = [];
    const callGatewayMock = vi.fn(async (options: CallGatewayCliOptions): Promise<unknown> => {
      methods.push(options.method);
      if (options.method === "openclaw.setup.detect") {
        return detectResult();
      }
      if (options.method === "openclaw.setup.activate.start") {
        throw new Error("gateway connection closed after request");
      }
      if (options.method === "wizard.cancel") {
        expect(options.params).toEqual({ sessionId: expect.any(String), closeInput: true });
        return { status: "cancelled" };
      }
      throw new Error(`unexpected Gateway method ${options.method}`);
    });
    const runTui = vi.fn();

    await expect(
      runWithGatewayMocks({
        callGateway: asGatewayCall(callGatewayMock),
        runTui,
      }),
    ).rejects.toThrow("gateway connection closed after request");

    expect(methods).toEqual([
      "openclaw.setup.detect",
      "openclaw.setup.activate.start",
      "wizard.cancel",
    ]);
    expect(runTui).not.toHaveBeenCalled();
  });

  it.each(["device", "unavailable"])(
    "preserves remote chat identity selection: %s",
    async (identity) => {
      if (identity === "unavailable") {
        vi.mocked(loadOrCreateDeviceIdentityAsync).mockImplementationOnce(() => {
          throw new Error("read-only client state");
        });
      }
      const methods: string[] = [];
      let chatOwner: string | undefined;
      let connections = 0;
      const callGatewayMock = vi.fn(async (options: CallGatewayCliOptions): Promise<unknown> => {
        methods.push(options.method);
        if (options.method === "openclaw.chat") {
          // One-shot requests need the same signed device across connections.
          const owner = options.deviceIdentity?.deviceId ?? `connection:${++connections}`;
          if (chatOwner && chatOwner !== owner) {
            throw new Error("OpenClaw session belongs to another caller.");
          }
          chatOwner = owner;
          return {
            sessionId: (options.params as { sessionId: string }).sessionId,
            reply: "Which channel should I configure?",
            action: "none",
          };
        }
        return setupReply(options);
      });
      const prompter = createWizardPrompter({
        text: vi
          .fn(async (): Promise<string> => {
            throw new WizardCancelledError("cancelled");
          })
          .mockResolvedValueOnce("Keep the existing configuration."),
      });
      const runTui = vi.fn();

      const onboarding = runWithGatewayMocks({
        callGateway: asGatewayCall(callGatewayMock),
        createPrompter: () => prompter,
        runTui,
      });

      if (identity === "unavailable") {
        await expect(onboarding).rejects.toThrow(/Cannot load device identity.*doctor --fix/);
        expect(methods).not.toContain("openclaw.chat");
        expect(runTui).not.toHaveBeenCalled();
        return;
      }
      await onboarding;

      expect(methods).toEqual([
        ...activationMethods,
        "openclaw.setup.verify",
        "openclaw.chat",
        "openclaw.chat",
      ]);
      expect(prompter.outro).toHaveBeenCalledWith("OpenClaw setup paused.");
      expect(runTui).not.toHaveBeenCalled();
    },
  );
});
