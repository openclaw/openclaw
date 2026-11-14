/* @vitest-environment jsdom */

import type { RequestFrame } from "@openclaw/gateway-protocol";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { GatewayPendingRequests } from "../../../../packages/gateway-client/src/pending-request.ts";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import type { SessionCreateOutcome } from "../../lib/sessions/create.ts";
import * as sessionFixtures from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createContext } from "./skill-workshop-page.test-support.ts";
import { SkillWorkshopPage } from "./skill-workshop-page.tsx";

afterEach(() => vi.useRealTimers());

const key = "agent:research:dashboard:7e93881c-0186-4d25-9e99-cdce85cac675";
const retainedRun = expect.objectContaining({ sessionKey: key, pendingRunId: "learning-run" });
const unresolved = () => new Promise<never>(() => {});

async function mountLearningPage(
  context = createContext(vi.fn(unresolved), { methods: ["sessions.create"] }),
) {
  const mounted = mountSolid(() => <SkillWorkshopPage />, {
    wrapper: createSolidApplicationContextProvider(context).wrapper,
  });
  const button = await waitForSolid(() =>
    mounted.getByRole<HTMLButtonElement>("button", { name: "Learn from history" }),
  );
  return { ...mounted, context, button };
}

it("starts one ordinary session and opens its acknowledged run", async () => {
  const { context, button } = await mountLearningPage();
  const creation = createDeferredCore<SessionCreateOutcome | null>();
  context.sessions.createResult = vi.fn(() => creation.promise);
  button.click();
  button.click();
  await waitForSolid(() => expect(button.disabled).toBe(true));

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
  flush();
  expect(button.disabled).toBe(false);
  expect(context.navigate).toHaveBeenCalledWith("chat", expect.any(Object));
  expect(context.chatSubmissions.retain).toHaveBeenCalledWith(retainedRun);
});

it("shows a failed creation without automatically retrying", async () => {
  const mounted = await mountLearningPage();
  const { context, button } = mounted;
  context.sessions.state.error = "The Gateway refused this session.";
  context.sessions.createResult = vi.fn(async () => null);
  button.click();
  await vi.waitFor(() =>
    expect(mounted.getByRole("alert").textContent).toContain("Gateway refused"),
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
      return method === "sessions.list"
        ? Promise.resolve(sessionFixtures.sessionsResult([]))
        : unresolved();
    },
  );
  const client = createTestGatewayClient(request);
  const context = createContext(request, { methods: ["sessions.create"] });
  const { gateway } = sessionFixtures.createGatewayHarness(client, ["sessions.create"], {
    initial: { ...context.gateway.snapshot, client, phase: "connected" },
  });
  const sessions = sessionFixtures.createTestSessionCapability(gateway, "research");
  Object.assign(context, { gateway, sessions });
  const create = vi.spyOn(sessions, "createResult");
  let mounted = await mountLearningPage(context);
  mounted.button.click();
  const frame = await sent.promise;
  mounted.unmount();
  expect(signal?.aborted).toBe(true);
  const payload = { key, runStarted: true, runId: "learning-run" };
  pending.handleResponse({ type: "res", id: frame.id, ok: true, payload });
  await create.mock.results[0]?.value;
  expect(context.chatSubmissions.retain).toHaveBeenCalledExactlyOnceWith(retainedRun);
  mounted = await mountLearningPage(context);
  expect(mounted.button.disabled).toBe(false);
  expect([create.mock.calls.length, sender.send.mock.calls.length]).toEqual([1, 1]);
  expect(context.navigate).not.toHaveBeenCalled();
});
