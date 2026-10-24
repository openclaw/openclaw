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

type Target = Parameters<typeof runRemoteGatewayInferenceOnboarding>[0];
type Guided = typeof import("./onboard-guided.js").runGuidedOnboarding;
type Reply = (options: CallGatewayCliOptions) => unknown;
const model = "claude-cli/opus";
const codexModel = "openai/gpt-5.5";
const activationMethods = ["openclaw.setup.detect", "openclaw.setup.activate.start", "wizard.next"];
const makeRuntime = (): RuntimeEnv => ({
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn() as unknown as RuntimeEnv["exit"],
});
const makeLocalConfig = (): OpenClawConfig => ({
  wizard: { securityAcknowledgedAt: "2026-07-11T00:00:00.000Z" },
  agents: { defaults: { workspace: "/client/workspace", model: { primary: "openai/local-only" } } },
  gateway: {
    mode: "remote",
    remote: { url: "wss://configured.example/ws", token: "configured-token" },
  },
});
const makeTarget = (
  auth: Pick<Target, "token" | "password"> = { token: "selected-token" },
): Target => ({
  config: makeLocalConfig(),
  gatewayUrl: "wss://selected.example/ws",
  tlsFingerprint: "sha256:selected",
  ...auth,
});

function detectResult() {
  return {
    candidates: [
      {
        kind: "claude-cli",
        brandId: "claude",
        label: "Claude Code",
        detail: "logged in",
        modelRef: model,
        recommended: true,
        credentials: true,
      },
      {
        kind: "codex-cli",
        brandId: "openai",
        label: "Codex",
        detail: "logged in",
        modelRef: codexModel,
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

function guided(kind = "claude-cli", chat = true): Guided {
  return async (_opts, runtime, deps) => {
    const detection = await expectDefined(deps?.detect, "detection adapter")();
    expect(detection.unavailableCandidates[0]?.id).toBe("antigravity-cli");
    expect(detection.prepareOptions).toBeUndefined();
    const selected = expectDefined(
      detection.candidates.find((entry) => entry.kind === kind),
      "candidate",
    );
    const activation = await expectDefined(
      deps?.activate,
      "activation adapter",
    )({
      kind: selected.kind,
      modelRef: selected.modelRef,
      workspace: "/client/workspace",
      surface: "cli",
      runtime,
    });
    if (chat && activation.ok) {
      await expectDefined(deps?.runSystemAgentChat, "chat adapter")(
        "/client/workspace",
        runtime,
        true,
      );
    }
    if (!chat) {
      expect(activation).toMatchObject({ ok: true, gatewayRestartRequired: true });
    }
  };
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

function setupReply(options: CallGatewayCliOptions, modelRef: string, restart: boolean) {
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
      throw new Error("unexpected Gateway method " + options.method);
  }
}

function run(
  options: {
    target?: Target;
    runtime?: RuntimeEnv;
    reply?: Reply;
    inspect?: (request: CallGatewayCliOptions) => void;
    guided?: Guided;
    prompter?: ReturnType<typeof createWizardPrompter>;
    tui?: typeof import("../tui/tui.js").runTui;
    modelRef?: string;
    restart?: boolean;
  } = {},
) {
  const call = vi.fn(async (request: CallGatewayCliOptions): Promise<unknown> => {
    options.inspect?.(request);
    return (
      options.reply?.(request) ??
      setupReply(request, options.modelRef ?? model, options.restart ?? false)
    );
  });
  mocks.callGateway.mockClear();
  mocks.callGateway.mockImplementation(
    call as unknown as typeof import("../gateway/call.js").callGatewayCli,
  );
  mocks.createPrompter.mockImplementation(() => options.prompter ?? createWizardPrompter());
  mocks.runGuidedOnboarding.mockImplementation(options.guided ?? guided());
  mocks.runTui.mockReset();
  if (options.tui) {
    mocks.runTui.mockImplementation(options.tui);
  }
  return runRemoteGatewayInferenceOnboarding(
    options.target ?? makeTarget(),
    options.runtime ?? makeRuntime(),
  );
}
const methods = () => mocks.callGateway.mock.calls.map(([request]) => request.method);

describe("runRemoteGatewayInferenceOnboarding", () => {
  it("preserves utility role through remote setup and rejects role drift", async () => {
    const selection = { modelRef: "fixture/small", modelTarget: "utility" };
    await expect(
      run({
        reply: (request) => {
          if (request.method === "openclaw.setup.detect") {
            return {
              ...detectResult(),
              setupModel: selection.modelRef,
              utilityModel: selection.modelRef,
              candidates: [
                {
                  kind: "provider-auto:fixture",
                  label: "Utility",
                  detail: "Setup",
                  recommended: false,
                  ...selection,
                },
              ],
            };
          }
          if (request.method === "openclaw.setup.activate.start") {
            expect(request.params).toMatchObject(selection);
            return {
              sessionId: "fixture-session",
              done: true,
              status: "done",
              modelActivation: selection,
            };
          }
          if (request.method === "openclaw.setup.verify") {
            expect(request.params).toEqual({ modelTarget: "utility" });
            return { ok: true, modelRef: selection.modelRef, latencyMs: 10 };
          }
          throw new Error("Unexpected request: " + request.method);
        },
        guided: async (_options, runtime, deps) => {
          const detection = await deps?.detect?.();
          expect(detection).toMatchObject({
            setupComplete: false,
            setupModel: "fixture/small",
            utilityModel: "fixture/small",
          });
          const choice = detection?.candidates[0];
          expect(choice?.modelTarget).toBe("utility");
          await deps?.activate?.({
            kind: "provider-auto:fixture",
            modelRef: "fixture/small",
            modelTarget: choice?.modelTarget,
            surface: "cli",
            runtime,
          });
        },
      }),
    ).rejects.toThrow("different model role");
  });

  // WizardSession terminal/cancellation state and credential promotion are covered by
  // wizard/session.test.ts and system-agent/setup-inference-activate.test.ts.
  it.each(["accept", "decline", "cancel"] as const)(
    "relays saved replacement confirmation through the Gateway wizard: %s",
    async (choice) => {
      const confirmation = "Connection verified. Activate this saved sign-in?";
      let sessionId: string;
      let next = 0;
      const prompter = createWizardPrompter({
        confirm: vi.fn(async () => {
          if (choice === "cancel") {
            throw new WizardCancelledError("cancelled");
          }
          return choice === "accept";
        }),
      });
      const onboarding = run({
        reply: (request) => {
          if (request.method === "openclaw.setup.activate.start") {
            const input = request.params as SystemAgentSetupActivateStartParams;
            sessionId = input.sessionId;
            expect(input.kind).toBe("saved-auth:openai:setup-replacement");
            return {
              sessionId,
              done: false,
              status: "running",
              step: { id: "note", type: "note", message: "Connection verified." },
            };
          }
          if (request.method === "wizard.cancel") {
            expect(request.params).toEqual({ sessionId, closeInput: true });
            return { status: "cancelled" };
          }
          if (request.method === "wizard.next") {
            const input = request.params as WizardNextParams;
            expect(input.sessionId).toBe(sessionId);
            if (next++ === 0) {
              expect(input.answer?.stepId).toBe("note");
              return {
                done: false,
                status: "running",
                step: {
                  id: "confirm",
                  type: "confirm",
                  message: confirmation,
                  initialValue: false,
                },
              };
            }
            expect(input.answer).toEqual({ stepId: "confirm", value: choice === "accept" });
            return choice === "accept"
              ? { done: true, status: "done", modelActivation: { modelRef: codexModel } }
              : {
                  done: true,
                  status: "error",
                  error: "Activation declined.",
                  activationRejection: {
                    disposition: "rejected-before-promotion",
                    status: "unavailable",
                  },
                };
          }
          if (request.method === "openclaw.setup.verify") {
            return { ok: true, modelRef: codexModel, latencyMs: 100 };
          }
          throw new Error("unexpected Gateway method " + request.method);
        },
        modelRef: codexModel,
        guided: async (_opts, runtime, deps) => {
          const result = await expectDefined(
            deps?.activate,
            "activation adapter",
          )({
            kind: "saved-auth:openai:setup-replacement",
            modelRef: codexModel,
            surface: "cli",
            runtime,
            prompter,
          });
          expect(result).toMatchObject(
            choice === "accept"
              ? { ok: true, modelRef: codexModel }
              : { ok: false, status: "unavailable" },
          );
        },
      });
      if (choice === "cancel") {
        await expect(onboarding).rejects.toThrow("cancelled");
      } else {
        await onboarding;
      }
      expect(prompter.confirm).toHaveBeenCalledWith({ message: confirmation, initialValue: false });
      expect(methods().filter((method) => method === "openclaw.setup.verify")).toHaveLength(
        choice === "accept" ? 1 : 0,
      );
      expect(methods().filter((method) => method === "wizard.cancel")).toHaveLength(
        choice === "cancel" ? 1 : 0,
      );
    },
  );

  it.each(["password", "ssh-token", "auth-free"] as const)(
    "pins %s through RPCs and in-process TUI",
    async (mode) => {
      const auth =
        mode === "password"
          ? { password: "selected-password" }
          : mode === "ssh-token"
            ? { token: "selected-token" }
            : {};
      const target = makeTarget(auth);
      const configuredRemote = mode === "ssh-token";
      if (configuredRemote) {
        target.gatewayUrl = "ws://127.0.0.1:18789";
        target.config.gateway = {
          ...target.config.gateway,
          remote: {
            url: target.gatewayUrl,
            transport: "ssh",
            sshTarget: "me@studio",
            remotePort: 18789,
          },
        };
        target.configuredRemote = true;
      }
      const original = structuredClone(target.config);
      const prompter = createWizardPrompter({ text: vi.fn(async () => "unexpected") });
      const runtime = makeRuntime();
      const tui = vi.fn(async () => ({ exitReason: "exit" as const }));
      await run({
        target,
        prompter,
        runtime,
        tui,
        inspect: (request) => {
          expect([
            request.url,
            request.token,
            request.password,
            request.tlsFingerprint,
            request.ignoreEnvUrlOverride,
          ]).toEqual([
            mode === "password" ? target.gatewayUrl : undefined,
            auth.token,
            auth.password,
            target.tlsFingerprint,
            true,
          ]);
          expect(request.config?.gateway?.remote).toMatchObject({
            url: target.gatewayUrl,
            transport: configuredRemote ? "ssh" : "direct",
          });
          if (request.method === "openclaw.setup.activate.start") {
            expect(request.params).toMatchObject({ workspace: "/gateway/workspace" });
          }
        },
        reply: (request) =>
          request.method === "openclaw.chat"
            ? {
                sessionId: (request.params as { sessionId: string }).sessionId,
                reply: "Ready.",
                action: "open-agent",
                ...(mode !== "auth-free" ? { agentDraft: "hatch" } : {}),
              }
            : undefined,
      });
      expect(methods()).toEqual([...activationMethods, "openclaw.setup.verify", "openclaw.chat"]);
      expect(tui).toHaveBeenCalledWith({
        config: expect.objectContaining({
          gateway: expect.objectContaining({
            remote: expect.objectContaining({ url: target.gatewayUrl }),
          }),
        }),
        deliver: false,
        ...(mode !== "auth-free" ? { message: "Wake up, my friend!" } : {}),
        boundGateway: {
          url: target.gatewayUrl,
          ...(configuredRemote ? { configuredRemote: true } : {}),
          ...auth,
          tlsFingerprint: target.tlsFingerprint,
        },
      });
      expect(target.config).toEqual(original);
      expect(prompter.text).not.toHaveBeenCalled();
      const secret = auth.token ?? auth.password;
      if (secret) {
        expect(process.argv).not.toContain(secret);
        expect(
          JSON.stringify([
            vi.mocked(prompter.note).mock.calls,
            vi.mocked(prompter.outro).mock.calls,
            vi.mocked(runtime.log).mock.calls,
            vi.mocked(runtime.error).mock.calls,
          ]),
        ).not.toContain(secret);
      }
    },
  );

  it.for([
    "request rejection",
    "typed unavailable result",
    "replacement",
    "missing activation identity",
    "missing verification identity",
    "restart timeout",
    "late deadline",
  ])("verifies the replacement Gateway before inference: %s", async (mode, ctx) => {
    const retries = mode === "request rejection" || mode === "typed unavailable result";
    const late = mode === "late deadline";
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    ctx.onTestFinished(() => now.mockRestore());
    if (late) {
      now.mockReturnValue(45_500).mockReturnValueOnce(1_000);
      const wallClock = vi.spyOn(Date, "now").mockReturnValue(-90_000);
      ctx.onTestFinished(() => wallClock.mockRestore());
    }
    let bootId: string | undefined = "old-boot";
    let connections = 0;
    let attempts = 0;
    const sent: string[] = [];
    const verified: string[] = [];
    const onboarding = run({
      modelRef: retries || late ? codexModel : model,
      guided: guided(retries || late ? "codex-cli" : "claude-cli", !(retries || late)),
      restart: true,
      inspect: (request) => {
        if (
          request.method === "openclaw.setup.activate.start" &&
          mode === "missing activation identity"
        ) {
          bootId = undefined;
        }
        if (request.method === "openclaw.setup.verify") {
          if (mode === "restart timeout") {
            now.mockReturnValue(45_000);
          } else if (retries || late || connections++ > 0) {
            bootId = mode === "missing verification identity" ? undefined : "new-boot";
          }
        }
        request.onHelloOk?.(gatewayHello(bootId));
        request.signal?.throwIfAborted();
        sent.push(request.method);
      },
      reply: (request) => {
        if (request.method === "openclaw.setup.verify") {
          verified.push(bootId ?? "unidentified");
          if (retries && attempts++ === 0) {
            if (mode === "typed unavailable result") {
              return { ok: false, status: "unavailable", error: "gateway restarting" };
            }
            throw Object.assign(new Error("gateway restarting"), {
              name: "GatewayClientRequestError",
              gatewayCode: "UNAVAILABLE",
              retryable: true,
              retryAfterMs: 0,
            });
          }
        }
        if (request.method === "openclaw.chat") {
          expect(bootId).toBe("new-boot");
          return { sessionId: "test-session", reply: "Ready.", action: "exit" };
        }
      },
    });
    if (mode.startsWith("missing") || mode === "restart timeout") {
      await expect(onboarding).rejects.toThrow(
        mode === "restart timeout"
          ? "Inference settings were saved, but the Gateway did not finish restarting"
          : "Inference settings were saved, but the Gateway did not provide a boot identity",
      );
      expect(verified).toEqual([]);
      expect(sent).toEqual(activationMethods);
    } else {
      await onboarding;
      expect(verified).toEqual(retries ? ["new-boot", "new-boot"] : ["new-boot"]);
      expect(sent).toEqual([
        ...activationMethods,
        "openclaw.setup.verify",
        ...(retries ? ["openclaw.setup.verify"] : []),
        ...(mode === "replacement" ? ["openclaw.chat"] : []),
      ]);
    }
    if (late) {
      expect(
        mocks.callGateway.mock.calls.find(
          ([request]) => request.method === "openclaw.setup.verify",
        )?.[0].timeoutMs,
      ).toBe(500);
    }
  });

  it.each([
    {
      verification: { ok: false, status: "auth", error: "credential expired" },
      error: "Gateway inference verification failed: credential expired",
    },
    {
      verification: { ok: true, modelRef: "openai/other", latencyMs: 100 },
      error: "Gateway verified openai/other, not the activated claude-cli/opus",
    },
  ])("fails closed before chat: $error", async ({ verification, error }) => {
    const target = makeTarget();
    const original = structuredClone(target.config);
    await expect(
      run({
        target,
        reply: (request) => (request.method === "openclaw.setup.verify" ? verification : undefined),
      }),
    ).rejects.toThrow(error);
    expect(methods()).toEqual([...activationMethods, "openclaw.setup.verify"]);
    expect(mocks.runTui).not.toHaveBeenCalled();
    expect(target.config).toEqual(original);
  });

  it("cancels an ambiguous activation failure without advancing or falling back locally", async () => {
    await expect(
      run({
        reply: (request) => {
          if (request.method === "openclaw.setup.activate.start") {
            throw new Error("gateway connection closed after request");
          }
          if (request.method === "wizard.cancel") {
            expect(request.params).toEqual({ sessionId: expect.any(String), closeInput: true });
            return { status: "cancelled" };
          }
        },
      }),
    ).rejects.toThrow("gateway connection closed after request");
    expect(methods()).toEqual([
      "openclaw.setup.detect",
      "openclaw.setup.activate.start",
      "wizard.cancel",
    ]);
    expect(mocks.runTui).not.toHaveBeenCalled();
  });

  it.each(["device", "unavailable"])(
    "preserves remote chat identity selection: %s",
    async (identity) => {
      if (identity === "unavailable") {
        vi.mocked(loadOrCreateDeviceIdentityAsync).mockImplementationOnce(() => {
          throw new Error("read-only client state");
        });
      }
      let chatOwner: string | undefined;
      let connections = 0;
      const prompter = createWizardPrompter({
        text: vi
          .fn(async (): Promise<string> => {
            throw new WizardCancelledError("cancelled");
          })
          .mockResolvedValueOnce("Keep the existing configuration."),
      });
      const onboarding = run({
        prompter,
        reply: (request) => {
          if (request.method !== "openclaw.chat") {
            return;
          }
          const owner = request.deviceIdentity?.deviceId ?? "connection:" + ++connections;
          if (chatOwner && chatOwner !== owner) {
            throw new Error("OpenClaw session belongs to another caller.");
          }
          chatOwner = owner;
          return {
            sessionId: (request.params as { sessionId: string }).sessionId,
            reply: "Which channel should I configure?",
            action: "none",
          };
        },
      });
      if (identity === "unavailable") {
        await expect(onboarding).rejects.toThrow(/Cannot load device identity.*doctor --fix/);
        expect(methods()).not.toContain("openclaw.chat");
      } else {
        await onboarding;
        expect(methods()).toEqual([
          ...activationMethods,
          "openclaw.setup.verify",
          "openclaw.chat",
          "openclaw.chat",
        ]);
        expect(prompter.outro).toHaveBeenCalledWith("OpenClaw setup paused.");
      }
      expect(mocks.runTui).not.toHaveBeenCalled();
    },
  );
});
