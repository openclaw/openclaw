import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { SystemAgentSetupAuthStartParams } from "../../../packages/gateway-protocol/src/index.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import { whenAdmittedWizardSessionSettled } from "./setup-admission.js";
import { callWizardNext, makeContext } from "./system-agent-setup.test-support.js";
import { systemAgentHandlers } from "./system-agent.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  RespondFn,
} from "./types.js";
import { wizardHandlers } from "./wizard.js";

const setupInferenceMocks = vi.hoisted(() => ({ activateSetupInference: vi.fn() }));
vi.mock("../../system-agent/setup-inference.js", () => ({
  activateSetupInference: setupInferenceMocks.activateSetupInference,
}));
const authClient = {
  connId: "auth-connection",
  connect: { device: { id: "auth-device" } },
  authenticatedUserProfile: { profileId: "auth-owner" },
} as GatewayClient;
const authParams = {
  authChoice: "github-copilot",
  agentId: "research",
  workspace: "/tmp/auth-workspace",
};

function authFixture() {
  const { wizardSessions, context } = makeContext();
  const released = createDeferredCore();
  const requests: Promise<unknown>[] = [];
  const start = (
    sessionId: string,
    overrides: Partial<SystemAgentSetupAuthStartParams> = {},
    client: GatewayClient = authClient,
    authority: Pick<GatewayRequestHandlerOptions, "sessionMutationCommitGuard"> = {},
  ) => {
    const respond = vi.fn<RespondFn>();
    const pending = Promise.resolve(
      expectDefined(
        systemAgentHandlers["openclaw.setup.auth.start"],
        "auth.start",
      )({
        params: { ...authParams, ...overrides, sessionId },
        client,
        context,
        respond,
        ...authority,
      } as never),
    );
    // Rejections remain available to the test while cleanup joins their settlement.
    requests.push(pending.catch(() => undefined));
    return { respond, pending };
  };
  return {
    wizardSessions,
    context,
    released,
    start,
    async first() {
      await start("auth-first").pending;
      await callWizardNext(context, { sessionId: "auth-first" });
      return expectDefined(wizardSessions.get("auth-first"), "first auth session");
    },
    async [Symbol.asyncDispose]() {
      for (const session of wizardSessions.values()) {
        session.cancel();
        const step = session.getCurrentStep();
        if (step) {
          await session.answer(step.id, null);
        }
      }
      released.resolve();
      await Promise.all(requests);
      for (const session of wizardSessions.values()) {
        session.cancel();
        await whenAdmittedWizardSessionSettled(session);
      }
    },
  };
}

const signedIn = { ok: true, modelRef: "github-copilot/test", latencyMs: 1, lines: [] };
async function signIn(prompter: WizardPrompter, message: string) {
  await prompter.note(message);
  return signedIn;
}

function expectRunning(respond: Mock<RespondFn>, sessionId: string) {
  expect(respond).toHaveBeenCalledExactlyOnceWith(
    true,
    { sessionId, done: false, status: "running" },
    undefined,
  );
}

async function expectPrompt(context: GatewayRequestContext, sessionId: string, message: string) {
  expect((await callWizardNext(context, { sessionId })).step?.message).toBe(message);
}

describe("openclaw.setup auth retries", () => {
  afterEach(() => {
    vi.resetAllMocks();
    resetCommandQueueStateForTest();
  });

  it.each([
    ["running", undefined, "during cleanup"],
    ["cancelled", undefined, "during cleanup"],
    ["running", "client invalidation", "before cancellation"],
    ["running", "request guard", "before cancellation"],
    ["running", "client invalidation", "during cleanup"],
    ["running", "request guard", "during cleanup"],
  ] as const)(
    "%s sign-in replacement with %s %s preserves cleanup and live retry authority",
    async (status, revocation, when) => {
      await using fixture = authFixture();
      const { wizardSessions, context, start, released: cleanupReleased } = fixture;
      const cleanupStarted = createDeferredCore();
      const authorityError = new Error("Queued request authority was revoked");
      const retryClient = { ...authClient, connId: "queued-connection", invalidated: false };
      let guardRevoked = false;
      setupInferenceMocks.activateSetupInference
        .mockImplementationOnce(async (params) => {
          try {
            await params.prompter.note("Complete the original sign-in");
          } finally {
            cleanupStarted.resolve();
            if (when === "during cleanup") {
              await cleanupReleased.promise;
            }
          }
        })
        .mockImplementation((params) =>
          signIn(params.prompter, "Complete the replacement sign-in"),
        );
      const original = await fixture.first();
      if (status === "cancelled") {
        await expectDefined(
          wizardHandlers["wizard.cancel"],
          "wizard.cancel",
        )({
          params: { sessionId: "auth-first" },
          context,
          respond: () => undefined,
        } as never);
      }
      const replacement = start("auth-replacement", {}, retryClient, {
        sessionMutationCommitGuard: () => {
          if (guardRevoked) {
            throw authorityError;
          }
        },
      });
      const result = replacement.pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      if (when === "during cleanup") {
        await Promise.race([cleanupStarted.promise, result]);
        expect(original.signal.aborted).toBe(true);
        expect(replacement.respond).not.toHaveBeenCalled();
        expect(setupInferenceMocks.activateSetupInference).toHaveBeenCalledOnce();
      }
      if (revocation === "client invalidation") {
        retryClient.invalidated = true;
      } else if (revocation === "request guard") {
        guardRevoked = true;
      }
      cleanupReleased.resolve();
      const error = await result;
      if (revocation) {
        if (when === "before cancellation") {
          expect(original.signal.aborted).toBe(false);
          expect(wizardSessions.get("auth-first")).toBe(original);
        }
        expect(setupInferenceMocks.activateSetupInference).toHaveBeenCalledOnce();
        expect(wizardSessions.has("auth-replacement")).toBe(false);
        expect(replacement.respond).not.toHaveBeenCalled();
        if (revocation === "request guard") {
          expect(error).toBe(authorityError);
        } else {
          expect(error).toMatchObject({ message: "Gateway requester authority changed" });
        }
      } else {
        expect(error).toBeUndefined();
      }
      const sessionId = revocation ? "auth-live" : "auth-replacement";
      const live = revocation ? start(sessionId) : replacement;
      await live.pending;
      expectRunning(live.respond, sessionId);
      expect(original.signal.aborted).toBe(true);
      expect(wizardSessions.has("auth-first")).toBe(false);
      await expectPrompt(context, sessionId, "Complete the replacement sign-in");
      expect(setupInferenceMocks.activateSetupInference).toHaveBeenCalledTimes(2);
    },
  );

  it("retains sign-in ownership after overlapping retries during preparation", async () => {
    await using fixture = authFixture();
    const { wizardSessions, context, start, released: releasePreparation } = fixture;
    const preparationStarted = createDeferredCore();
    setupInferenceMocks.activateSetupInference
      .mockImplementationOnce(async (params) => {
        await params.beforePersistentEffect();
        preparationStarted.resolve();
        await releasePreparation.promise;
        params.onPreparationComplete();
        await params.prompter.note("Complete the original sign-in");
        return signedIn;
      })
      .mockImplementationOnce((params) =>
        signIn(params.prompter, "Complete the replacement sign-in"),
      );
    const first = start("auth-first");
    await first.pending;
    await preparationStarted.promise;
    const session = expectDefined(wizardSessions.get("auth-first"), "preparing auth session");
    const second = start("auth-second");
    const third = start("auth-third");
    await Promise.all([second.pending, third.pending]);
    for (const retry of [second, third]) {
      expect(retry.respond).toHaveBeenCalledExactlyOnceWith(
        false,
        undefined,
        expect.objectContaining({ details: { code: "SETUP_ADMISSION_BUSY" } }),
      );
    }
    expect(session.signal.aborted).toBe(false);
    expect(setupInferenceMocks.activateSetupInference).toHaveBeenCalledOnce();

    releasePreparation.resolve();
    await expectPrompt(context, "auth-first", "Complete the original sign-in");
    const replacement = start("auth-replacement");
    await replacement.pending;
    expectRunning(replacement.respond, "auth-replacement");
    expect(session.signal.aborted).toBe(true);
    expect(wizardSessions.has("auth-first")).toBe(false);
    await expectPrompt(context, "auth-replacement", "Complete the replacement sign-in");
    expect(setupInferenceMocks.activateSetupInference).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["owner", {}],
    ["choice", { authChoice: "xai" }],
    ["agent", { agentId: "other-agent" }],
    ["workspace", { workspace: "/tmp/other-auth-workspace" }],
    ["modelTarget", { modelTarget: "utility" }],
    ["nativeSessionCatalogsEnabled", { nativeSessionCatalogsEnabled: true }],
    ["commit", {}],
  ] satisfies Array<[string, Partial<SystemAgentSetupAuthStartParams>]>)(
    "keeps another sign-in busy when its %s prevents replacement",
    async (difference, overrides) => {
      await using fixture = authFixture();
      const { start, released } = fixture;
      setupInferenceMocks.activateSetupInference.mockImplementationOnce(async (params) => {
        if (difference === "commit") {
          await params.onCommitStarted();
        }
        await params.prompter.note("Sign-in still owns setup");
        await released.promise;
        return signedIn;
      });
      const session = await fixture.first();
      const replacement = start(
        "auth-replacement",
        overrides,
        difference === "owner"
          ? {
              ...authClient,
              authenticatedUserProfile: {
                ...authClient.authenticatedUserProfile!,
                profileId: "other-owner",
              },
            }
          : authClient,
      );
      await replacement.pending;
      expect(replacement.respond).toHaveBeenCalledExactlyOnceWith(
        false,
        undefined,
        expect.objectContaining({
          message: "OpenClaw setup is already in progress; try again when it finishes.",
        }),
      );
      expect(session.signal.aborted).toBe(false);
      expect(setupInferenceMocks.activateSetupInference).toHaveBeenCalledOnce();
    },
  );
});
