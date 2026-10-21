/* @vitest-environment jsdom */

import type { RequestFrame } from "@openclaw/gateway-protocol";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { GatewayPendingRequests } from "../../../../packages/gateway-client/src/pending-request.ts";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import type { SessionCreateOutcome } from "../../lib/sessions/create.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createContext } from "./skill-workshop-page.test-support.ts";
import { SkillWorkshopPage } from "./skill-workshop-page.tsx";

afterEach(() => vi.useRealTimers());

const key = "agent:research:dashboard:7e93881c-0186-4d25-9e99-cdce85cac675";
const retainedRun = expect.objectContaining({ sessionKey: key, pendingRunId: "learning-run" });
const unresolved = () => new Promise<never>(() => {});

function learningContext(request: ReturnType<typeof vi.fn> = vi.fn(unresolved)) {
  return createContext(request, { methods: ["sessions.create"] });
}

async function mountLearningPage(context = learningContext()) {
  const mounted = mountSolid(() => <SkillWorkshopPage />, {
    wrapper: createSolidApplicationContextProvider(context).wrapper,
  });
  const button = await waitForSolid(() =>
    mounted.getByRole<HTMLButtonElement>("button", { name: "Learn from history" }),
  );
  return { ...mounted, page: mounted.container, context, button };
}

it("starts one ordinary session and opens its acknowledged run", async () => {
  const { context, button } = await mountLearningPage();
  const creation = createDeferredCore<SessionCreateOutcome | null>();
  context.sessions.createResult = vi.fn(() => creation.promise);
  button.click();
  button.click();

  expect(context.sessions.createResult).toHaveBeenCalledExactlyOnceWith(
    {
      agentId: "research",
      displayName: "Learn from past conversations",
      message: expect.stringContaining("past conversations"),
      idempotencyKey: expect.any(String),
    },
    { reconciliation: "background", signal: expect.any(AbortSignal) },
  );
  expect(context.navigate).not.toHaveBeenCalled();
  creation.resolve({ key, initialRun: { status: "started", runId: "learning-run" } });
  await vi.waitFor(() => expect(context.navigate).toHaveBeenCalledOnce());
  expect(context.navigate).toHaveBeenCalledWith("chat", expect.any(Object));
  expect(context.chatSubmissions.retain).toHaveBeenCalledWith(retainedRun);
});

it("shows a failed creation without automatically retrying", async () => {
  const { page, context, button } = await mountLearningPage();
  context.sessions.state.error = "The Gateway refused this session.";
  context.sessions.createResult = vi.fn(async () => null);
  button.click();
  await vi.waitFor(() =>
    expect(page.querySelector('[role="alert"]')?.textContent).toContain("Gateway refused"),
  );
  expect(context.sessions.createResult).toHaveBeenCalledOnce();
  expect(context.navigate).not.toHaveBeenCalled();
});

it("retains an accepted run without redirecting a replaced Workshop page", async () => {
  vi.useFakeTimers();
  const sent = createDeferredCore<RequestFrame>();
  const pending = new GatewayPendingRequests({ createRequestId: () => "1", nowMs: Date.now });
  const sender = { send: vi.fn((data: string) => sent.resolve(JSON.parse(data) as RequestFrame)) };
  onTestFinished(() => pending.flush(new Error("Workshop test complete")));
  let signal: AbortSignal | undefined;
  const request = vi.fn(
    (method: string, params?: unknown, options?: Parameters<typeof pending.request>[3]) => {
      if (method === "sessions.create") {
        signal = options?.signal;
        return pending.request(sender, method, params, options);
      }
      return method === "sessions.list" ? Promise.resolve(sessionsResult([])) : unresolved();
    },
  );
  const client = createTestGatewayClient(request);
  const context = learningContext(request);
  const { gateway } = createGatewayHarness(client, ["sessions.create"], {
    initial: {
      hello: context.gateway.snapshot.hello,
      sessionKey: "global",
      assistantAgentId: "research",
    },
  });
  const sessions = createTestSessionCapability(gateway, "research");
  Object.assign(context, { gateway, sessions });
  const create = vi.spyOn(sessions, "createResult");
  let mounted = await mountLearningPage(context);
  mounted.button.click();
  const frame = await sent.promise;
  expect(frame.method).toBe("sessions.create");
  mounted.unmount();
  expect(signal?.aborted).toBe(true);
  pending.handleResponse({
    type: "res",
    id: frame.id,
    ok: true,
    payload: { key, runStarted: true, runId: "learning-run" },
  });
  await create.mock.results[0]?.value;
  expect(context.chatSubmissions.retain).toHaveBeenCalledExactlyOnceWith(retainedRun);
  mounted = await mountLearningPage(context);
  expect(mounted.button.disabled).toBe(false);
  expect([create.mock.calls.length, sender.send.mock.calls.length]).toEqual([1, 1]);
  expect(context.navigate).not.toHaveBeenCalled();
});
