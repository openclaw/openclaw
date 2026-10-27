/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationPlacementStartupStatus } from "../../app/session-placement-startup.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";

const session = (key: string): GatewaySessionRow => ({
  key: `agent:main:${key}`,
  sessionId: key,
  agentId: "main",
  kind: "direct",
  updatedAt: 1,
});

it("publishes placement status without admitting another transcript message", async () => {
  const row = session("placement-publication");
  const sessionKey = row.key;
  const mounted = createMountedPanes([row]);
  let status: ApplicationPlacementStartupStatus | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: ApplicationPlacementStartupStatus | null) => {
    status = next;
    listeners.forEach((listener) => listener());
    flush();
  };
  vi.spyOn(mounted.context.placementStartup, "get").mockImplementation(() => status);
  vi.spyOn(mounted.context.placementStartup, "subscribe").mockImplementation((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  const pane = mounted.mount(sessionKey);
  await refreshPane(pane);
  await waitForSolid(() => expect(pane.querySelector("textarea")).not.toBeNull());

  publish({
    sessionKey,
    phase: "failed",
    startedAt: 1,
    error: "Synthetic placement startup failed",
  });
  expect(pane.textContent).toContain("Synthetic placement startup failed");
  expect(pane.state.chatMessages).toEqual([]);

  publish(null);
  expect(pane.textContent).not.toContain("Synthetic placement startup failed");
});

it("retires a replayed first prompt already collected into loaded history after its duplicate ACK", async () => {
  const row = session("collected-startup");
  const sessionKey = row.key;
  const messageId = "collected-first-input";
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
    sessionInfo: { ...row, hasActiveRun: false },
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
  const sent = createDeferred<{ runId: string; status: string }>();
  const sending = createDeferred();
  const mounted = createMountedPanes([row], "main", undefined, {
    "chat.history": history,
    "chat.startup": history,
    "chat.send": () => {
      sending.resolve();
      return sent.promise;
    },
  });
  const pane = mounted.mount(sessionKey);
  await refreshPane(pane);
  expect(pane.state.chatMessages).toEqual([aggregate]);
  const client = mounted.context.gateway.snapshot.client!;
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
  await sending.promise;
  sent.resolve({ runId: messageId, status: "ok" });
  await waitForSolid(() => {
    expect(mounted.context.placementStartup.get(sessionKey)).toBeNull();
    expect(pane.state.chatMessages).toEqual([aggregate]);
    expect(mounted.context.chatSubmissions.readInitial(sessionKey, client)?.pending).toBe(false);
    expect(pane.state.chatRunId).toBeNull();
  });
});
