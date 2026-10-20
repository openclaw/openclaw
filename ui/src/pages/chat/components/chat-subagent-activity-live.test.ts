/* @vitest-environment jsdom */
import { createComponent } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import type { SessionObserverDigest } from "../../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { createTestSessionCapability } from "../../../lib/sessions/session-capability.test-support.ts";
import type { SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import { disposeSidebarContextLifecycles } from "../../../test-helpers/app-sidebar-context-lifecycle.ts";
import { createContext } from "../../../test-helpers/app-sidebar.ts";
import { createApplicationGateway } from "../../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../../test-helpers/solid-application-context.tsx";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { projectSubagentStatus } from "../chat-subagent-wait.ts";
import { ChatSubagentActivity } from "./chat-subagent-activity-live.tsx";
import type { SubagentActivityProps } from "./chat-subagent-activity.tsx";

type ActivityElement = SolidBridgeElement<SubagentActivityProps>;

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
  const sessions = createTestSessionCapability(connection.gateway);
  const subscribe = vi
    .spyOn(sessions, "subscribeMessages")
    .mockImplementation(async (key, options) => ({
      key,
      agentId: options?.agentId,
      mode: options?.mode,
    }));
  const unsubscribe = vi.spyOn(sessions, "unsubscribeMessages").mockResolvedValue();
  const provider = createSolidApplicationContextProvider(
    createContext(connection.gateway, sessions),
  );
  const subscriptions = vi.spyOn(connection.gateway, "subscribeEvents");
  const view = mountSolid(() => createComponent(ChatSubagentActivity, { rows: rows(child) }), {
    wrapper: provider.wrapper,
  });
  const element = view.container.querySelector<ActivityElement>("openclaw-chat-subagent-activity")!;
  onTestFinished(() => {
    view.unmount();
    sessions.dispose();
    disposeSidebarContextLifecycles();
  });
  flush();
  const publish = (event: string, payload: unknown) => {
    connection.publishEvent({ type: "event", event, payload });
    flush();
  };
  const narrate = (text: string, runId = "child-run") =>
    publish("session.narration", { sessionKey: child.key, runId, text });
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
  const emit = async (patch: Partial<SessionObserverDigest> = {}) =>
    publish("session.observer", { ...digest, ...patch });
  expect(subscribe).toHaveBeenCalledWith(child.key, expect.objectContaining({ mode: "narration" }));
  narrate("Reading sources. **Checking the API response.**");
  expect(element.textContent).toContain("Checking the API response.");
  await Promise.resolve();
  element.presented = false;
  expect(unsubscribe).toHaveBeenCalledWith(expect.objectContaining({ key: child.key }));
  flush();
  expect(element.textContent).not.toContain("Checking the API response.");
  element.presented = true;
  await element.updateComplete;
  expect(subscribe).toHaveBeenCalledTimes(2);
  narrate("Stale narration", "old-run");
  expect(element.textContent).not.toContain("Stale narration");
  narrate("");
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
  element.compact = true;
  await emit({
    revision: 4,
    headline: "Running the backend tests",
    planProgress: { completed: 1, total: 3 },
  });
  expect(element.querySelector(".chat-subagent-activity__steps")?.textContent).toBe("1/3");
  expect(element.querySelector("meter")?.value).toBe(1);
  expect(element.querySelector(".chat-subagent-activity__row")?.getAttribute("title")).toBe(
    "Backend implementation. Running. Running the backend tests. 1 of 3 steps",
  );
  await emit({ revision: 5, headline: "Running the backend tests" });
  expect(element.querySelector(".chat-subagent-activity__steps")).toBeNull();
  element.compact = false;
  connection.publish({ ...connection.gateway.snapshot, hello: gatewayHelloForMethods([]) });
  flush();
  expect(element.textContent).not.toContain("Running the backend tests");
  await emit();
  expect(element.textContent).toContain(digest.headline);
  element.rows = rows({ ...child, activeRunIds: ["replacement-run"] });
  flush();
  expect(element.textContent).not.toContain(digest.headline);
  await emit({ revision: 10 });
  expect(element.textContent).not.toContain(digest.headline);
  element.rows = rows(child);
  flush();
  expect(element.textContent).not.toContain(digest.headline);
  await emit({ revision: 11 });
  expect(element.textContent).toContain(digest.headline);
  view.unmount();
  flush();
  expect(subscriptions).toHaveBeenCalledTimes(1);
  await emit({ runId: "replacement-run" });
  expect(view.container.textContent).toBe("");
});
