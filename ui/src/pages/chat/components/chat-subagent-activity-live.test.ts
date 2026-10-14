/* @vitest-environment jsdom */
import { expect, it, onTestFinished, vi } from "vitest";
import type { SessionObserverDigest } from "../../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { createTestSessionCapability } from "../../../lib/sessions/session-capability.test-support.ts";
import { disposeSidebarContextLifecycles } from "../../../test-helpers/app-sidebar-context-lifecycle.ts";
import { createContext } from "../../../test-helpers/app-sidebar.ts";
import { createApplicationGateway } from "../../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import { projectSubagentStatus } from "../chat-subagent-wait.ts";
import { ChatSubagentActivityLive } from "./chat-subagent-activity-live.ts";

it("keeps live child headlines scoped to their run, incarnation, and connection", async () => {
  const connection = createApplicationGateway();
  connection.publish({ ...connection.gateway.snapshot, hello: gatewayHelloForMethods([]) });
  const parent = {
    key: "agent:main:parent",
    kind: "direct",
    hasActiveSubagentRun: true,
  } satisfies GatewaySessionRow;
  const child: GatewaySessionRow = {
    key: "agent:main:subagent:child",
    sessionId: "child-id",
    lifecycleRevision: "incarnation-1",
    kind: "direct",
    label: "Backend implementation",
    spawnedBy: parent.key,
    hasActiveRun: true,
    activeRunIds: ["child-run"],
  };
  const rows = (session: GatewaySessionRow) =>
    projectSubagentStatus(
      {
        selectedSession: parent,
        messages: [],
        subagentSessions: [session],
        subagentSessionsHydrated: true,
      },
      false,
    ).activity;
  const element = new ChatSubagentActivityLive();
  const sessions = createTestSessionCapability(connection.gateway);
  element.context = createContext(connection.gateway, sessions);
  const subscriptions = vi.spyOn(connection.gateway, "subscribeEvents");
  element.rows = rows(child);
  document.body.append(element);
  onTestFinished(() => {
    element.remove();
    sessions.dispose();
    disposeSidebarContextLifecycles();
  });
  await element.updateComplete;
  const digest: SessionObserverDigest = {
    sessionKey: child.key,
    agentId: "main",
    sessionId: child.sessionId,
    lifecycleRevision: child.lifecycleRevision,
    runId: "child-run",
    revision: 2,
    updatedAt: 2_000,
    headline: "Verifying the API response",
    health: "on-track",
  };
  const emit = async (patch: Partial<SessionObserverDigest> = {}) => {
    connection.publishEvent({
      type: "event",
      event: "session.observer",
      payload: { ...digest, ...patch },
    });
    await element.updateComplete;
  };
  await emit();
  expect(element.textContent).toContain(digest.headline);
  for (const patch of [
    { revision: 1 },
    { runId: "old-run" },
    { sessionId: "replaced-child" },
    { lifecycleRevision: "old-incarnation" },
    { agentId: "other" },
    { sessionKey: "agent:main:unrelated" },
  ]) {
    await emit({ ...patch, headline: "Stale activity" });
    expect(element.textContent).not.toContain("Stale activity");
  }
  await emit({ revision: 3, headline: "Running the backend tests" });
  expect(element.textContent).toContain("Running the backend tests");
  connection.publish({ ...connection.gateway.snapshot, hello: gatewayHelloForMethods([]) });
  await element.updateComplete;
  expect(element.textContent).not.toContain("Running the backend tests");
  await emit();
  expect(element.textContent).toContain(digest.headline);
  element.rows = rows({ ...child, activeRunIds: ["replacement-run"] });
  await element.updateComplete;
  expect(element.textContent).not.toContain(digest.headline);
  await emit({ revision: 10 });
  expect(element.textContent).not.toContain(digest.headline);
  element.requestUpdate();
  element.remove();
  await element.updateComplete;
  expect(subscriptions).toHaveBeenCalledTimes(1);
  const update = vi.spyOn(element, "requestUpdate");
  await emit({ runId: "replacement-run" });
  expect(update).not.toHaveBeenCalled();
});
