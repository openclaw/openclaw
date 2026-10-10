/* @vitest-environment jsdom */
import { expect, it, onTestFinished } from "vitest";
import type { SessionsProcessesListResult } from "../../../../../packages/gateway-protocol/src/schema/session-processes.js";
import { createTestSessionCapability } from "../../../lib/sessions/session-capability.test-support.ts";
import { disposeSidebarContextLifecycles } from "../../../test-helpers/app-sidebar-context-lifecycle.ts";
import { createContext, createGatewayHarness } from "../../../test-helpers/app-sidebar.ts";
import { createApplicationContextProvider } from "../../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import "./chat-processes-panel.ts";

it.each([false, true])(
  "distinguishes a retired process from an incomplete list (truncated: %s)",
  async (truncated) => {
    let result: SessionsProcessesListResult = {
      sessionId: "parent-session",
      truncated: false,
      processes: [
        {
          processId: "build",
          instanceId: "build-instance",
          name: "Build app",
          status: "running",
          startedAt: 1,
          tail: "Compiling",
          truncated: false,
          canStop: false,
        },
      ],
    };
    const client = createTestGatewayClient(() => result);
    const connection = createGatewayHarness(client);
    connection.publish({
      hello: gatewayHelloForMethods(["sessions.processes.list", "sessions.processes.stop"]),
    });
    const sessions = createTestSessionCapability(connection.gateway);
    const provider = createApplicationContextProvider(createContext(connection.gateway, sessions));
    const panel = document.createElement("openclaw-chat-processes-panel");
    panel.sessionKey = "agent:main:parent";
    provider.append(panel);
    document.body.append(provider);
    onTestFinished(() => {
      provider.remove();
      sessions.dispose();
      disposeSidebarContextLifecycles();
    });
    await panel.updateComplete;
    await panel.refresh();
    await panel.updateComplete;
    panel.querySelector<HTMLButtonElement>(".chat-processes__open")!.click();
    await panel.updateComplete;
    expect(panel.textContent).toContain("Compiling");
    result = { sessionId: "parent-session", processes: [], truncated };
    await panel.refresh();
    await panel.updateComplete;
    if (truncated) {
      expect(panel.textContent).toContain("limited list");
      expect(panel.textContent).not.toContain("no longer retained");
    } else {
      expect(panel.textContent).toContain("no longer retained");
    }
  },
);
