import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SystemAgentSetupAuthStartParams } from "../../../packages/gateway-protocol/src/index.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import type { WizardSession } from "../../wizard/session.js";
import { whenAdmittedWizardSessionSettled } from "./setup-admission.js";
import { callWizardNext, makeContext } from "./system-agent-setup.test-support.js";
import { systemAgentHandlers } from "./system-agent.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./types.js";
import { wizardHandlers } from "./wizard.js";

const setupInferenceMocks = vi.hoisted(() => ({ activateSetupInference: vi.fn() }));
vi.mock("../../system-agent/setup-inference.js", () => ({
  activateSetupInference: setupInferenceMocks.activateSetupInference,
}));
function makeRespond() {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  return {
    calls,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      calls.push({ ok, payload, error });
    },
  };
}

function systemAgentHandler(method: keyof typeof systemAgentHandlers) {
  return expectDefined(systemAgentHandlers[method], `systemAgentHandlers["${method}"] invariant`);
}

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

function startAuthRequest(
  context: GatewayRequestContext,
  sessionId: string,
  overrides: Partial<SystemAgentSetupAuthStartParams> = {},
  client: GatewayClient = authClient,
  authority: Pick<GatewayRequestHandlerOptions, "sessionMutationCommitGuard"> = {},
) {
  const { calls, respond } = makeRespond();
  const pending = Promise.resolve(
    systemAgentHandler("openclaw.setup.auth.start")({
      params: { ...authParams, ...overrides, sessionId },
      client,
      context,
      respond,
      ...authority,
    } as never),
  );
  return { calls, pending };
}

async function settleAuthRequests(
  wizardSessions: Map<string, WizardSession>,
  pending: Array<Promise<unknown>>,
  release: () => void,
) {
  for (const session of wizardSessions.values()) {
    session.cancel();
  }
  release();
  await Promise.all(pending);
  for (const session of wizardSessions.values()) {
    session.cancel();
    await whenAdmittedWizardSessionSettled(session);
  }
}

const signedIn = { ok: true, modelRef: "github-copilot/test", latencyMs: 1, lines: [] };
async function signIn(prompter: WizardPrompter, message: string) {
  await prompter.note(message);
  return signedIn;
}

function expectRunning(calls: ReturnType<typeof makeRespond>["calls"], sessionId: string) {
  expect(calls).toEqual([
    { ok: true, payload: { sessionId, done: false, status: "running" }, error: undefined },
  ]);
}

async function expectPrompt(context: GatewayRequestContext, sessionId: string, message: string) {
  expect((await callWizardNext(context, { sessionId })).step?.message).toBe(message);
}

describe("openclaw.setup auth retries", () => {
  afterEach(() => {
    vi.resetAllMocks();
    resetCommandQueueStateForTest();
  });

  it.each(["running", "cancelled"] as const)(
    "starts a replacement after %s sign-in cleanup settles",
    async (status) => {
      const { wizardSessions, context } = makeContext();
      const cleanupStarted = createDeferredCore();
      const cleanupReleased = createDeferredCore();
      setupInferenceMocks.activateSetupInference
        .mockImplementationOnce(async (params) => {
          try {
            await params.prompter.note("Complete browser sign-in");
          } finally {
            cleanupStarted.resolve();
            await cleanupReleased.promise;
          }
        })
        .mockImplementationOnce((params) =>
          signIn(params.prompter, "Complete the replacement sign-in"),
        );
      const first = startAuthRequest(context, "auth-first");
      const requests = [first.pending];
      try {
        await first.pending;
        const session = expectDefined(wizardSessions.get("auth-first"), "first auth session");
        await callWizardNext(context, { sessionId: "auth-first" });
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
        const replacement = startAuthRequest(context, "auth-replacement");
        requests.push(replacement.pending);
        await Promise.race([cleanupStarted.promise, replacement.pending]);
        expect(session.signal.aborted).toBe(true);
        expect(replacement.calls).toEqual([]);
        expect(setupInferenceMocks.activateSetupInference).toHaveBeenCalledOnce();
        cleanupReleased.resolve();
        await replacement.pending;
        const sessionId = "auth-replacement";
        expect(wizardSessions.has("auth-first")).toBe(false);
        expectRunning(replacement.calls, sessionId);
        await expectPrompt(context, sessionId, "Complete the replacement sign-in");
        expect(setupInferenceMocks.activateSetupInference).toHaveBeenCalledTimes(2);
      } finally {
        await settleAuthRequests(wizardSessions, requests, () => cleanupReleased.resolve());
      }
    },
  );

  it.each([
    { when: "before cancellation", revocation: "client invalidation" },
    { when: "before cancellation", revocation: "request guard" },
    { when: "during cleanup", revocation: "client invalidation" },
    { when: "during cleanup", revocation: "request guard" },
  ] as const)(
    "rejects a queued retry on $revocation $when and preserves a later live retry",
    async ({ when, revocation }) => {
      const { wizardSessions, context } = makeContext();
      const cleanupStarted = createDeferredCore();
      const cleanupReleased = createDeferredCore();
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
          signIn(params.prompter, "Complete the live replacement sign-in"),
        );
      const first = startAuthRequest(context, "auth-first");
      const requests: Array<Promise<unknown>> = [first.pending];
      try {
        await first.pending;
        const original = expectDefined(wizardSessions.get("auth-first"), "original sign-in");
        await callWizardNext(context, { sessionId: "auth-first" });
        const denied = startAuthRequest(context, "auth-denied", {}, retryClient, {
          sessionMutationCommitGuard: () => {
            if (guardRevoked) {
              throw authorityError;
            }
          },
        });
        const deniedResult = denied.pending.then(
          () => undefined,
          (error: unknown) => error,
        );
        requests.push(deniedResult);
        if (when === "during cleanup") {
          await Promise.race([cleanupStarted.promise, deniedResult]);
          expect(original.signal.aborted).toBe(true);
        }
        if (revocation === "client invalidation") {
          retryClient.invalidated = true;
        } else {
          guardRevoked = true;
        }
        cleanupReleased.resolve();
        const error = await deniedResult;

        if (when === "before cancellation") {
          expect(original.signal.aborted).toBe(false);
          expect(wizardSessions.get("auth-first")).toBe(original);
        }
        expect(setupInferenceMocks.activateSetupInference).toHaveBeenCalledOnce();
        expect(wizardSessions.has("auth-denied")).toBe(false);
        expect(denied.calls).toEqual([]);
        if (revocation === "request guard") {
          expect(error).toBe(authorityError);
        } else {
          expect(error).toMatchObject({ message: "Gateway requester authority changed" });
        }

        const live = startAuthRequest(context, "auth-live");
        requests.push(live.pending);
        await live.pending;
        expect(live.calls[0]).toMatchObject({
          ok: true,
          payload: { sessionId: "auth-live", done: false, status: "running" },
        });
        expect(original.signal.aborted).toBe(true);
        expect(wizardSessions.has("auth-first")).toBe(false);
        await expectPrompt(context, "auth-live", "Complete the live replacement sign-in");
        expect(setupInferenceMocks.activateSetupInference).toHaveBeenCalledTimes(2);
      } finally {
        await settleAuthRequests(wizardSessions, requests, () => cleanupReleased.resolve());
      }
    },
  );

  it("retains sign-in ownership after overlapping retries during preparation", async () => {
    const { wizardSessions, context } = makeContext();
    const preparationStarted = createDeferredCore();
    const releasePreparation = createDeferredCore();
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
    const first = startAuthRequest(context, "auth-first");
    const requests = [first.pending];
    try {
      await first.pending;
      await preparationStarted.promise;
      const session = expectDefined(wizardSessions.get("auth-first"), "preparing auth session");
      const second = startAuthRequest(context, "auth-second");
      const third = startAuthRequest(context, "auth-third");
      requests.push(second.pending, third.pending);
      await Promise.all([second.pending, third.pending]);
      for (const retry of [second, third]) {
        expect(retry.calls).toEqual([
          {
            ok: false,
            payload: undefined,
            error: expect.objectContaining({ details: { code: "SETUP_ADMISSION_BUSY" } }),
          },
        ]);
      }
      expect(session.signal.aborted).toBe(false);
      expect(setupInferenceMocks.activateSetupInference).toHaveBeenCalledOnce();

      releasePreparation.resolve();
      await expectPrompt(context, "auth-first", "Complete the original sign-in");
      const replacement = startAuthRequest(context, "auth-replacement");
      requests.push(replacement.pending);
      await replacement.pending;
      expectRunning(replacement.calls, "auth-replacement");
      expect(session.signal.aborted).toBe(true);
      expect(wizardSessions.has("auth-first")).toBe(false);
      await expectPrompt(context, "auth-replacement", "Complete the replacement sign-in");
      expect(setupInferenceMocks.activateSetupInference).toHaveBeenCalledTimes(2);
    } finally {
      await settleAuthRequests(wizardSessions, requests, () => releasePreparation.resolve());
    }
  });

  it.each([
    "owner",
    "choice",
    "agent",
    "workspace",
    "modelTarget",
    "nativeSessionCatalogsEnabled",
    "commit",
  ] as const)("keeps another sign-in busy when its %s prevents replacement", async (difference) => {
    const { wizardSessions, context } = makeContext();
    const released = createDeferredCore();
    setupInferenceMocks.activateSetupInference.mockImplementationOnce(async (params) => {
      if (difference === "commit") {
        await params.onCommitStarted();
      }
      await params.prompter.note("Sign-in still owns setup");
      await released.promise;
      return signedIn;
    });
    const first = startAuthRequest(context, "auth-first");
    const requests = [first.pending];
    try {
      await first.pending;
      const session = expectDefined(wizardSessions.get("auth-first"), "first auth session");
      const note = await callWizardNext(context, { sessionId: "auth-first" });
      const replacement = startAuthRequest(
        context,
        "auth-replacement",
        (
          {
            choice: { authChoice: "xai" },
            agent: { agentId: "other-agent" },
            workspace: { workspace: "/tmp/other-auth-workspace" },
            modelTarget: { modelTarget: "utility" as const },
            nativeSessionCatalogsEnabled: { nativeSessionCatalogsEnabled: true },
            owner: {},
            commit: {},
          } satisfies Record<typeof difference, Partial<SystemAgentSetupAuthStartParams>>
        )[difference],
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
      requests.push(replacement.pending);
      await replacement.pending;
      expect(replacement.calls).toEqual([
        {
          ok: false,
          payload: undefined,
          error: expect.objectContaining({
            message: "OpenClaw setup is already in progress; try again when it finishes.",
          }),
        },
      ]);
      expect(session.signal.aborted).toBe(false);
      expect(setupInferenceMocks.activateSetupInference).toHaveBeenCalledOnce();
      if (difference === "commit") {
        await session.answer(expectDefined(note.step, "locked sign-in step").id, null);
      }
    } finally {
      released.resolve();
      const session = wizardSessions.get("auth-first");
      const step = session?.getCurrentStep();
      if (step) {
        await session?.answer(step.id, null);
      }
      await settleAuthRequests(wizardSessions, requests, () => released.resolve());
    }
  });
});
