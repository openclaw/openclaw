/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-tool-icons.test/"} */
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import * as iconLoader from "../plugins/icon-loader.ts";
import { createMountedPanes } from "./chat-pane-mounted.test-support.ts";
import { ChatPaneView } from "./chat-pane.tsx";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

afterEach(() => vi.restoreAllMocks());

it("renders plugin artwork for accepted history absent from the capped session list", async () => {
  installTranscriptDomMocks();
  onTestFinished(resetTranscriptTestDom);
  const sessionKey = "agent:main:older-chat";
  const sessionInfo: GatewaySessionRow = {
    key: sessionKey,
    kind: "direct",
    updatedAt: 1,
    agentId: "main",
    sessionId: "older-session",
  };
  const history = async () => ({
    sessionInfo,
    sessionId: sessionInfo.sessionId,
    messages: [
      {
        role: "assistant",
        timestamp: 1,
        content: [{ type: "toolCall", id: "example-call", name: "example_tool", arguments: {} }],
      },
    ],
  });
  const fixture = createMountedPanes([], "main", undefined, {
    "chat.history": history,
    "chat.startup": history,
  });
  const client = expectDefined(fixture.context.gateway.snapshot.client, "pane Gateway client");
  const originalRequest = client.request.bind(client);
  const request = vi.spyOn(client, "request").mockImplementation(async (method, ...args) => {
    if (method === "tools.effective") {
      return {
        agentId: "main",
        profile: "full",
        groups: [
          {
            id: "plugin",
            label: "Tools",
            source: "plugin",
            tools: [
              {
                id: "example_tool",
                label: "Example",
                description: "",
                rawDescription: "",
                pluginId: "example",
                source: "plugin",
              },
            ],
          },
        ],
      };
    }
    if (method === "plugins.list") {
      return {
        plugins: [
          {
            id: "example",
            name: "Example",
            installed: true,
            enabled: true,
            state: "enabled",
            hasIcon: true,
            hasActivityIcon: true,
          },
        ],
        diagnostics: [],
        mutationAllowed: false,
      };
    }
    return originalRequest(method, ...args);
  });
  vi.spyOn(iconLoader, "fetchPluginActivityIconBlobUrl").mockResolvedValue("blob:tool-icon");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  const container = document.body.appendChild(createApplicationContextProvider(fixture.context));
  onTestFinished(() => container.remove());
  const view = mountSolid(
    () => (
      <ApplicationProvider value={fixture.context}>
        <ChatPaneView paneId="tool-icons" sessionKey={sessionKey} active />
      </ApplicationProvider>
    ),
    { container },
  );
  onTestFinished(view.unmount);
  await waitForSolid(() => {
    expect(request).toHaveBeenCalledWith(
      "tools.effective",
      { sessionKey, agentId: "main" },
      expect.anything(),
    );
    expect(view.container.querySelector('img[src="blob:tool-icon"]')).not.toBeNull();
  });
});
