/* @vitest-environment jsdom */

import type { RequestFrame } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => document.body.replaceChildren());

async function mountLearningPage(
  context = createContext(
    vi.fn(() => new Promise<never>(() => {})),
    { methods: ["sessions.create"] },
  ),
) {
  const mounted = mountSolid(() => <SkillWorkshopPage />, {
    wrapper: createSolidApplicationContextProvider(context).wrapper,
  });
  const page = mounted.container.querySelector<HTMLElement>("openclaw-skill-workshop-page")!;
  await waitForSolid(() => expect(page.querySelector("button")).not.toBeNull());
  const button = Array.from(page.querySelectorAll("button")).find(
    (entry) => entry.textContent?.trim() === "Learn from history",
  );
  expect(button).toBeDefined();
  return { page, context, button: button!, unmount: mounted.unmount };
}

describe("Workshop learning session", () => {
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
    const key = "agent:research:dashboard:7e93881c-0186-4d25-9e99-cdce85cac675";
    creation.resolve({ key, initialRun: { status: "started", runId: "learning-run" } });
    await vi.waitFor(() => expect(context.navigate).toHaveBeenCalledOnce());
    expect(context.navigate).toHaveBeenCalledWith("chat", expect.any(Object));
    expect(context.chatSubmissions.retain).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: key, pendingRunId: "learning-run" }),
    );
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
    const frames: RequestFrame[] = [];
    let nextRequestId = 0;
    const pending = new GatewayPendingRequests({
      createRequestId: () => String(++nextRequestId),
      nowMs: () => Date.now(),
    });
    const sender = {
      send: (data: string) => {
        const frame = JSON.parse(data) as RequestFrame;
        frames.push(frame);
        sent.resolve(frame);
      },
    };
    let signal: AbortSignal | undefined;
    const request = vi.fn(
      (method: string, params?: unknown, options?: Parameters<typeof pending.request>[3]) => {
        if (method === "sessions.create") {
          signal = options?.signal;
          return pending.request(sender, method, params, options);
        }
        if (method === "sessions.list") {
          return Promise.resolve(sessionsResult([]));
        }
        return new Promise<never>(() => {});
      },
    );
    const context = createContext(request, { methods: ["sessions.create"] });
    const client = createTestGatewayClient(request);
    const gateway = createGatewayHarness(client, ["sessions.create"], {
      initial: {
        hello: context.gateway.snapshot.hello,
        sessionKey: "global",
        assistantAgentId: "research",
      },
    });
    const sessions = createTestSessionCapability(gateway.gateway, "research");
    Object.assign(context, { gateway: gateway.gateway, sessions });
    const create = vi.spyOn(sessions, "createResult");
    let mounted: Awaited<ReturnType<typeof mountLearningPage>> | undefined;
    try {
      mounted = await mountLearningPage(context);
      mounted.button.click();
      const frame = await sent.promise;
      expect(frame.method).toBe("sessions.create");
      mounted.unmount();
      expect(signal?.aborted).toBe(true);
      const key = "agent:research:dashboard:7e93881c-0186-4d25-9e99-cdce85cac675";
      pending.handleResponse({
        type: "res",
        id: frame.id,
        ok: true,
        payload: { key, runStarted: true, runId: "learning-run" },
      });
      await create.mock.results[0]?.value;
      expect(context.navigate).not.toHaveBeenCalled();
      expect(context.chatSubmissions.retain).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ sessionKey: key, pendingRunId: "learning-run" }),
      );
      mounted = await mountLearningPage(context);
      expect(mounted.button.disabled).toBe(false);
      expect(create).toHaveBeenCalledOnce();
      expect(frames).toHaveLength(1);
      expect(context.navigate).not.toHaveBeenCalled();
    } finally {
      mounted?.unmount();
      sessions.dispose();
      pending.flush(new Error("Workshop test complete"));
      vi.useRealTimers();
    }
  });
});
