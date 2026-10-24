/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationPlacementStartupStatus } from "../../app/session-placement-startup.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";

it("publishes placement status without admitting another transcript message", async () => {
  const sessionKey = "agent:main:placement-publication";
  const mounted = createMountedPanes([
    {
      key: sessionKey,
      sessionId: "placement-session",
      agentId: "main",
      kind: "direct",
      updatedAt: 1,
    },
  ]);
  let status: ApplicationPlacementStartupStatus | null = null;
  const listeners = new Set<() => void>();
  Object.assign(mounted.context, {
    placementStartup: {
      ...mounted.context.placementStartup,
      get: () => status,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  });
  const pane = mounted.mount(sessionKey);
  await refreshPane(pane);
  await waitForSolid(() => expect(pane.querySelector("textarea")).not.toBeNull());
  expect(pane.state.chatMessages).toEqual([]);

  status = {
    sessionKey,
    phase: "failed",
    startedAt: 1,
    error: "Synthetic placement startup failed",
  };
  listeners.forEach((listener) => listener());
  flush();
  expect(pane.textContent).toContain("Synthetic placement startup failed");
  expect(pane.state.chatMessages).toEqual([]);

  status = null;
  listeners.forEach((listener) => listener());
  flush();
  expect(pane.textContent).not.toContain("Synthetic placement startup failed");
});

it("retires a replayed first prompt already collected into loaded history after its duplicate ACK", async () => {
  const sessionKey = "agent:main:collected-startup";
  const messageId = "collected-first-input";
  const row: GatewaySessionRow = {
    key: sessionKey,
    sessionId: "collected-session",
    agentId: "main",
    kind: "direct",
    updatedAt: 1,
  };
  const aggregate = {
    role: "user",
    content: [{ type: "text", text: "Collected initial task and follow-up" }],
    __openclaw: {
      id: "aggregate-input",
      seq: 1,
      idempotencyKey: "followup-collect:session:batch",
    },
  };
  const history = (_method: string, params: unknown) => ({
    messages: [aggregate],
    sessionId: row.sessionId,
    sessionInfo: row,
    pendingInputs: { items: [], total: 0 },
    inputReceipts:
      params &&
      typeof params === "object" &&
      "inputRunIds" in params &&
      Array.isArray(params.inputRunIds) &&
      params.inputRunIds.includes(messageId)
        ? [{ runId: messageId, state: "consumed", consumedByEventId: "aggregate-input" }]
        : [],
  });
  const mounted = createMountedPanes([row], "main", undefined, {
    "chat.history": history,
    "chat.startup": history,
  });
  const pane = mounted.mount(sessionKey);
  await refreshPane(pane);
  expect(pane.state.chatMessages).toEqual([aggregate]);
  const client = mounted.context.gateway.snapshot.client!;
  const sent = createDeferred<{ runId: string; status: string }>();
  const request = client.request.bind(client);
  const requestSpy = vi
    .spyOn(client, "request")
    .mockImplementation(
      async <T>(...args: Parameters<typeof client.request>): Promise<T> =>
        (await (args[0] === "chat.send" ? sent.promise : request(...args))) as T,
    );
  mounted.context.placementStartup.start({
    recovery: {
      sessionKey,
      sessionId: row.sessionId,
      messageId,
      message: "Initial task",
      target: { kind: "profile", profileId: "synthetic-worker" },
      agentId: "main",
      gatewayUrl: mounted.context.gateway.connection.gatewayUrl,
      recoveryScope: client.recoveryScope,
      phase: "sending",
    },
    persistRecovery: false,
    mode: "recover",
    createdAt: 1,
  });
  await vi.waitFor(() =>
    expect(requestSpy).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({ idempotencyKey: messageId }),
      expect.anything(),
    ),
  );
  sent.resolve({ runId: messageId, status: "ok" });
  await waitForSolid(() => {
    expect(mounted.context.placementStartup.get(sessionKey)).toBeNull();
    expect(pane.state.chatMessages).toEqual([aggregate]);
    expect(mounted.context.chatSubmissions.readInitial(sessionKey, client)?.pending).toBe(false);
  });
});
