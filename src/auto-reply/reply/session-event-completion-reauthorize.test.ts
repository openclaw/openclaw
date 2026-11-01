import "../../test-utils/prepare-compiled-subprocesses.js";
import { expect, it, vi } from "vitest";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import * as senderToolPolicy from "../../agents/sender-tool-policy.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "./session-event-handoff.js";
import {
  configureEventState,
  openEventToolHost,
  runEventFixture,
} from "./session-event.test-support.js";

// mock-isolation: Only model inference is synthetic; the session-event admission, the
// completion turn's assembled tool surface, and the sender-policy dispatch decision are real.
vi.mock("../../agents/embedded-agent-runner/run.js", () => ({
  runEmbeddedAgent: vi.fn(),
}));
const runEmbeddedAgentMock = vi.mocked(runEmbeddedAgent);

// Regression for openclaw/openclaw#177510: an owner-origin background exec completion wakes
// the session as an internal continuation turn and must reauthorize against the originating
// requester's CURRENT toolsBySender policy. The issue's minimal config authorizes the owner
// ONLY through an agent-level toolsBySender entry (no commands.ownerAllowFrom), with a
// wildcard deny that strips exec/process for every other sender.
const OWNER = "owner-1";
const GUEST = "guest-1";
const ACCOUNT = "owner-account";
const scope = { agentId: "main", sessionKey: "agent:main:completion-reauthorize" };

type SenderPolicyCall = {
  senderId: string | null | undefined;
  messageProvider: string | null | undefined;
};

/** Partial overrides merged into the fixture's base config (which supplies agents.defaults). */
function toolsBySenderOverrides(ownerDeny?: string[]): Partial<OpenClawConfig> {
  return {
    channels: { telegram: {} },
    tools: {
      profile: "coding",
      codeMode: false,
      toolSearch: false,
      toolsBySender: {
        [`id:${OWNER}`]: ownerDeny ? { deny: ownerDeny } : {},
        "*": { deny: ["exec", "process", "nodes", "gateway"] },
      },
    },
  };
}

async function seedSession() {
  await replaceSessionEntry(scope, {
    sessionId: "completion-reauthorize",
    lifecycleRevision: "same-generation",
    permissionMode: "full",
    updatedAt: Date.now(),
    sessionStartedAt: Date.now(),
    delivery: {
      kind: "external",
      context: { channel: "telegram", to: "-100group", accountId: ACCOUNT },
    },
  });
}

/** The host-owned exec caller supplies the requester origin; the producer only retains it. */
function requesterOrigin(senderId: string) {
  return {
    ...scope,
    requesterOrigin: {
      ...scope,
      messageProvider: "telegram",
      accountId: ACCOUNT,
      senderId,
    },
  };
}

/** Admits the completion turn and returns the real tool names its assembled surface exposes. */
function recordCompletionSurface() {
  let surface: string[] = [];
  let senderIsOwner: boolean | undefined;
  runEmbeddedAgentMock.mockReset().mockImplementation(async (params: RunEmbeddedAgentParams) => {
    const { tools, close } = await openEventToolHost(params, "completion admission", {
      includeOpenClawTools: true,
    });
    try {
      surface = tools.map((tool) => tool.name);
      senderIsOwner = params.senderIsOwner;
    } finally {
      close();
    }
    return { payloads: [{ text: "Completion observed" }], meta: { durationMs: 1 } };
  });
  return {
    surface: () => surface,
    senderIsOwner: () => senderIsOwner,
  };
}

function enqueueCompletion(
  expectedTarget: Awaited<ReturnType<typeof captureSessionEventTargetForHost>>,
  signal: AbortSignal,
) {
  return enqueueSessionEventForHost("Background command finished.", {
    ...scope,
    source: "exec",
    expectedTarget,
    abortSignal: signal,
    deliver: false,
    deliveryContext: { channel: "telegram", to: "-100group", accountId: ACCOUNT },
  });
}

it.for([
  { requester: OWNER, label: "owner", gateway: true },
  { requester: GUEST, label: "unknown/guest", gateway: false },
] as const)(
  "reauthorizes the exec completion turn against the originating requester's current policy: $label",
  async (row, { signal, onTestFinished }) => {
    await runEventFixture("session-event-completion-reauthorize", onTestFinished, async (state) => {
      await configureEventState(state, toolsBySenderOverrides());
      await seedSession();
      const record = recordCompletionSurface();
      // Call-through spy: observe the sender identity the completion turn resolves without
      // changing the real policy decision.
      const senderSpy = vi.spyOn(senderToolPolicy, "resolveSenderToolPolicy");
      try {
        const target = await withGatewayToolCallerIdentity(requesterOrigin(row.requester), () =>
          captureSessionEventTargetForHost(scope.agentId, scope.sessionKey, {
            retainRequesterOwner: true,
          }),
        );
        const receipt = enqueueCompletion(target, signal);
        const settled = await receipt.settled;
        expect(settled, `completion error: ${settled.error ?? ""}`).toMatchObject({
          status: "completed",
        });
        const names = record.surface();
        const has = (name: string) => names.includes(name);
        expect(names, `completion surface: ${names.join(", ")}`).toContain("read");
        // The owner's own completion retains the wildcard-denied owner tools under its
        // unchanged policy; the unknown/guest requester is still stripped by the wildcard.
        expect(has("gateway"), `completion surface: ${names.join(", ")}`).toBe(row.gateway);
        // A toolsBySender-only owner is not a *command* owner, so the completion turn must
        // not impersonate the owner (senderIsOwner stays false) while still revalidating
        // their toolsBySender-scoped surface.
        expect(record.senderIsOwner()).toBe(false);
        // Dispatch decision: the completion turn resolves the originating requester's
        // CURRENT sender policy (owner entry, not the wildcard).
        const completionCalls = senderSpy.mock.calls
          .map((call) => call[0] as SenderPolicyCall)
          .filter((call): call is SenderPolicyCall => Boolean(call))
          .map((call) => ({ senderId: call.senderId, messageProvider: call.messageProvider }));
        expect(completionCalls, `sender policy calls: ${JSON.stringify(completionCalls)}`).toEqual(
          expect.arrayContaining([{ senderId: row.requester, messageProvider: "telegram" }]),
        );
      } finally {
        senderSpy.mockRestore();
      }
    });
  },
);

it("fails closed when the owner revokes their own exec before the completion is admitted", async ({
  signal,
  onTestFinished,
}) => {
  await runEventFixture("session-event-completion-revoked", onTestFinished, async (state) => {
    const config = await configureEventState(state, toolsBySenderOverrides());
    await seedSession();
    const record = recordCompletionSurface();
    const senderSpy = vi.spyOn(senderToolPolicy, "resolveSenderToolPolicy");
    try {
      const target = await withGatewayToolCallerIdentity(requesterOrigin(OWNER), () =>
        captureSessionEventTargetForHost(scope.agentId, scope.sessionKey, {
          retainRequesterOwner: true,
        }),
      );
      // The owner revokes exec for their own sender after launch but before the completion.
      setRuntimeConfigSnapshot({
        ...config,
        ...toolsBySenderOverrides(["exec", "process", "gateway"]),
      });
      const receipt = enqueueCompletion(target, signal);
      const settled = await receipt.settled;
      expect(settled, `completion error: ${settled.error ?? ""}`).toMatchObject({
        status: "completed",
      });
      const names = record.surface();
      expect(names, `completion surface: ${names.join(", ")}`).toContain("read");
      expect(names).not.toContain("gateway");
      // Dispatch decision: the revocation is resolved against the owner's own sender entry,
      // so the wildcard is not what strips the tools.
      const completionCalls = senderSpy.mock.calls
        .map((call) => call[0] as SenderPolicyCall)
        .filter((call): call is SenderPolicyCall => Boolean(call))
        .map((call) => ({ senderId: call.senderId, messageProvider: call.messageProvider }));
      expect(completionCalls, `sender policy calls: ${JSON.stringify(completionCalls)}`).toEqual(
        expect.arrayContaining([{ senderId: OWNER, messageProvider: "telegram" }]),
      );
    } finally {
      senderSpy.mockRestore();
    }
  });
});
