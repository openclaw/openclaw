import { expectDefined } from "@openclaw/normalization-core";
import { Compile } from "typebox/compile";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SystemAgentSetupAuthStartParams,
  WizardNextParams,
  WizardNextResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { WizardNextResultSchema } from "../../../packages/gateway-protocol/src/schema/wizard.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { WizardSession } from "../../wizard/session.js";
import { whenAdmittedWizardSessionSettled } from "./setup-admission.js";
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
const validateWizardResult = Compile(WizardNextResultSchema);

function makeContext() {
  const wizardSessions = new Map<string, WizardSession>();
  return {
    wizardSessions,
    context: {
      wizardSessions,
      findRunningWizard: () => undefined,
      purgeWizardSession: (id: string) => wizardSessions.delete(id),
    } as unknown as GatewayRequestContext,
  };
}

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

async function callWizardNext(
  context: GatewayRequestContext,
  params: WizardNextParams,
): Promise<WizardNextResult> {
  const { calls, respond } = makeRespond();
  await expectDefined(
    wizardHandlers["wizard.next"],
    "wizard.next handler",
  )({
    params,
    respond,
    context,
  } as never);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.ok).toBe(true);
  const payload = calls[0]?.payload;
  if (!validateWizardResult.Check(payload)) {
    throw new Error("wizard.next returned an invalid result");
  }
  return payload;
}

describe("openclaw.setup auth retries", () => {
  afterEach(() => {
    vi.resetAllMocks();
    resetCommandQueueStateForTest();
  });

  it.each(["running", "cancelled"] as const)(
    "replaces the owner's %s sign-in after provider cleanup settles",
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
        .mockImplementationOnce(async (params) => {
          await params.prompter.note("Complete the replacement sign-in");
          return { ok: true, modelRef: "github-copilot/test", latencyMs: 1, lines: [] };
        });
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
        expect(wizardSessions.has("auth-first")).toBe(false);
        expect(replacement.calls).toEqual([
          {
            ok: true,
            payload: { sessionId: "auth-replacement", done: false, status: "running" },
            error: undefined,
          },
        ]);
        const step = await callWizardNext(context, { sessionId: "auth-replacement" });
        expect(step.step?.message).toBe("Complete the replacement sign-in");
        expect(setupInferenceMocks.activateSetupInference).toHaveBeenCalledTimes(2);
      } finally {
        await settleAuthRequests(wizardSessions, requests, () => cleanupReleased.resolve());
      }
    },
  );

  it("runs only the latest sign-in when retries overlap provider cleanup", async () => {
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
      .mockImplementation(async (params) => {
        await params.prompter.note("Latest sign-in");
        return { ok: true, modelRef: "github-copilot/test", latencyMs: 1, lines: [] };
      });
    const first = startAuthRequest(context, "auth-first");
    const requests = [first.pending];
    try {
      await first.pending;
      const session = expectDefined(wizardSessions.get("auth-first"), "first auth session");
      await callWizardNext(context, { sessionId: "auth-first" });
      const second = startAuthRequest(context, "auth-second");
      requests.push(second.pending);
      await Promise.race([cleanupStarted.promise, second.pending]);
      expect(session.signal.aborted).toBe(true);
      const duplicate = startAuthRequest(context, "auth-second");
      requests.push(duplicate.pending);
      await duplicate.pending;
      expect(duplicate.calls[0]).toMatchObject({
        ok: false,
        error: { message: "wizard session already exists" },
      });
      expect(second.calls).toEqual([]);
      const third = startAuthRequest(context, "auth-third");
      requests.push(third.pending);
      cleanupReleased.resolve();
      await Promise.all([second.pending, third.pending]);
      expect(second.calls).toEqual([
        {
          ok: true,
          payload: { sessionId: "auth-second", done: true, status: "cancelled" },
          error: undefined,
        },
      ]);
      expect(third.calls[0]).toMatchObject({
        ok: true,
        payload: { sessionId: "auth-third", done: false, status: "running" },
      });
      expect(wizardSessions.has("auth-second")).toBe(false);
      expect((await callWizardNext(context, { sessionId: "auth-third" })).step?.message).toBe(
        "Latest sign-in",
      );
      expect(setupInferenceMocks.activateSetupInference).toHaveBeenCalledTimes(2);
    } finally {
      await settleAuthRequests(wizardSessions, requests, () => cleanupReleased.resolve());
    }
  });

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
        .mockImplementation(async (params) => {
          await params.prompter.note("Complete the live replacement sign-in");
          return { ok: true, modelRef: "github-copilot/test", latencyMs: 1, lines: [] };
        });
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
        expect((await callWizardNext(context, { sessionId: "auth-live" })).step?.message).toBe(
          "Complete the live replacement sign-in",
        );
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
        return { ok: true, modelRef: "github-copilot/test", latencyMs: 1, lines: [] };
      })
      .mockImplementationOnce(async (params) => {
        await params.prompter.note("Complete the replacement sign-in");
        return { ok: true, modelRef: "github-copilot/test", latencyMs: 1, lines: [] };
      });
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
      expect((await callWizardNext(context, { sessionId: "auth-first" })).step?.message).toBe(
        "Complete the original sign-in",
      );
      const replacement = startAuthRequest(context, "auth-replacement");
      requests.push(replacement.pending);
      await replacement.pending;
      expect(replacement.calls).toEqual([
        {
          ok: true,
          payload: { sessionId: "auth-replacement", done: false, status: "running" },
          error: undefined,
        },
      ]);
      expect(session.signal.aborted).toBe(true);
      expect(wizardSessions.has("auth-first")).toBe(false);
      expect((await callWizardNext(context, { sessionId: "auth-replacement" })).step?.message).toBe(
        "Complete the replacement sign-in",
      );
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
      return { ok: true, modelRef: "github-copilot/test", latencyMs: 1, lines: [] };
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
        difference === "choice"
          ? { authChoice: "xai" }
          : difference === "agent"
            ? { agentId: "other-agent" }
            : difference === "workspace"
              ? { workspace: "/tmp/other-auth-workspace" }
              : difference === "modelTarget"
                ? { modelTarget: "utility" }
                : difference === "nativeSessionCatalogsEnabled"
                  ? { nativeSessionCatalogsEnabled: true }
                  : {},
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
