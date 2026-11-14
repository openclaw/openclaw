/* @vitest-environment jsdom */
import { fireEvent } from "@solidjs/testing-library";
import { expect, it, onTestFinished, vi } from "vitest";
import type { SessionsProcessesListResult } from "../../../../../packages/gateway-protocol/src/schema/session-processes.js";
import { createTestSessionCapability } from "../../../lib/sessions/session-capability.test-support.ts";
import { disposeSidebarContextLifecycles } from "../../../test-helpers/app-sidebar-context-lifecycle.ts";
import { createContext, createGatewayHarness } from "../../../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createComposerProps } from "../chat-composer.test-support.ts";
import { ChatComposerWaiters } from "./chat-composer-waiters.tsx";

const row = (processId: string, extra: Partial<SessionsProcessesListResult["processes"][0]>) => ({
  processId,
  instanceId: `${processId}-instance`,
  name: processId,
  status: "running" as const,
  startedAt: 1,
  tail: "",
  truncated: false,
  canStop: true,
  ...extra,
});

it("shows only processes that will continue the chat and opens their output", async () => {
  let processes = [
    row("until gh pr checks 42", { wakesSession: true }),
    row("pnpm dev", {}),
    row("old waiter", { status: "completed", endedAt: 2 }),
  ];
  const connection = createGatewayHarness(
    createTestGatewayClient(() => ({ sessionId: "s", truncated: false, processes })),
  );
  connection.publish({ hello: gatewayHelloForMethods(["sessions.processes.list"]) });
  const sessions = createTestSessionCapability(connection.gateway);
  const provider = createSolidApplicationContextProvider(
    createContext(connection.gateway, sessions),
  );
  onTestFinished(() => {
    sessions.dispose();
    disposeSidebarContextLifecycles();
  });
  const onOpen = vi.fn();
  const composer = createComposerProps({
    sessionKey: "agent:main:main",
    onOpenProcesses: onOpen,
  });
  const view = mountSolid(() => <ChatComposerWaiters composer={composer} />, {
    wrapper: provider.wrapper,
  });
  await waitForSolid(() => expect(view.getByRole("button")).toBeTruthy());
  const only = view.getByRole("button");
  expect(only.textContent).toContain("Waiting on");
  expect(only.textContent).toContain("until gh pr checks 42");
  expect(view.container.textContent).not.toContain("pnpm dev");
  fireEvent.click(only);
  expect(onOpen).toHaveBeenCalledWith("until gh pr checks 42-instance");

  processes = [...processes, row("tail -f build.log", { wakesSession: true, startedAt: 5 })];
  connection.publishEvent("sessions.processes.changed", {
    sessionKey: "agent:main:main",
    agentId: "main",
  });
  await waitForSolid(() => expect(view.container.textContent).toContain("Waiting on 2 processes"));
  const summary = view.getByRole("button", { expanded: false });
  fireEvent.click(summary);
  await waitForSolid(() => expect(view.getAllByRole("listitem")).toHaveLength(2));
});
