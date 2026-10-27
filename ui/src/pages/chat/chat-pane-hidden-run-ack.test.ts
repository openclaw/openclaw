/* @vitest-environment jsdom */

import { expect, it, onTestFinished, vi } from "vitest";
import type { SessionsPatchManyParams } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { setChatHistoryLoad } from "./chat-history-state.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";

it("batches 150 folded read acknowledgements without concurrent requests", async () => {
  const htmlStyle = document.documentElement.getAttribute("style");
  onTestFinished(() => {
    if (htmlStyle === null) {
      document.documentElement.removeAttribute("style");
    } else {
      document.documentElement.setAttribute("style", htmlStyle);
    }
  });
  const parent: GatewaySessionRow = {
    key: "agent:main:current",
    sessionId: "parent",
    kind: "direct",
    unread: false,
    updatedAt: 10,
  };
  const rows: GatewaySessionRow[] = [
    parent,
    ...Array.from({ length: 150 }, (_, index) => ({
      key: `agent:main:subagent:run-${index}`,
      sessionId: `run-${index}`,
      kind: "direct" as const,
      spawnedBy: parent.key,
      status: "done" as const,
      unread: true,
      updatedAt: 20,
    })),
  ];
  const requests: { method: string; targets: SessionsPatchManyParams["targets"] }[] = [];
  let inFlight = 0;
  let peak = 0;
  let completed = 0;
  const client = createTestGatewayClient(async (method, raw) => {
    if (method === "sessions.list") {
      return sessionsResult(rows, 30);
    }
    if (method !== "sessions.patch" && method !== "sessions.patchMany") {
      return {};
    }
    const params = raw as SessionsPatchManyParams & { key: string };
    const targets = method === "sessions.patchMany" ? params.targets : [{ key: params.key }];
    requests.push({ method, targets });
    peak = Math.max(peak, ++inFlight);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    for (const target of targets) {
      const row = rows.find((entry) => entry.key === target.key)!;
      row.unread = false;
      row.lastReadAt = 30;
    }
    inFlight -= 1;
    completed += targets.length;
    return method === "sessions.patchMany"
      ? { outcomes: targets.map(({ key, agentId }) => ({ key, agentId, ok: true })) }
      : { ok: true, key: params.key, path: "", entry: rows.find((row) => row.key === params.key) };
  });
  const { pane, state, sessions } = createTestChatPane({ client });
  onTestFinished(() => {
    sessions.dispose();
    pane.disconnectedCallback();
  });
  await sessions.refresh({ force: true });
  state.sessionsResult = sessions.state.result;
  setChatHistoryLoad(state, {
    phase: "committed",
    sessions,
    client,
    connectionEpoch: state.connectionEpoch,
    sessionKey: parent.key,
    requestAgentId: undefined,
    sessionInfo: parent,
  });
  pane.markSessionRead(parent);
  pane.markSessionRead(parent);
  await vi.waitFor(() => expect(completed).toBe(150));
  const counts = {
    patch: requests.filter((request) => request.method === "sessions.patch").length,
    patchMany: requests.filter((request) => request.method === "sessions.patchMany").length,
    peak,
  };
  expect(counts).toEqual({ patch: 0, patchMany: 2, peak: 1 });
  expect(requests.map((request) => request.targets.length)).toEqual([100, 50]);
  expect(requests.flatMap((request) => request.targets)).toEqual(
    rows.slice(1).map((row) => ({
      key: row.key,
      agentId: "main",
      expectedSessionId: row.sessionId,
      expectedMarkedUnreadAt: null,
    })),
  );
});
