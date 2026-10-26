/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ApplicationContext } from "../../app/context-types.ts";
import { McpAppView } from "../../components/mcp-app-view-lazy.ts";
import { i18n } from "../../i18n/index.ts";
import { createApplicationGateway } from "../../test-helpers/application-context-fixtures.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import type { ChatPaneProps } from "../chat/chat-pane-inputs.ts";
import { AppsPage } from "./apps-page.tsx";

// mock-isolation: Keep the conversation boundary real without starting the chat runtime.
vi.mock("../chat/chat-pane.tsx", async () => {
  const { defineSolidBridge } = await import("../../lib/solid-bridge.ts");
  const { useApplication } = await import("../../lib/reactive/context.ts");
  const { chatPaneProperties } = await import("../chat/chat-pane-inputs.ts");
  return {
    ChatPaneView: defineSolidBridge<ChatPaneProps>(
      "openclaw-chat-pane",
      () => {
        useApplication();
        return null;
      },
      { properties: chatPaneProperties },
    ),
  };
});
// mock-isolation: The chat route's styles and page registration are covered by browser CI.
vi.mock("../chat/route-entry.ts", () => ({}));

beforeEach(() => i18n.setLocale("en"));

function mountApps(
  discovered: Promise<void>,
  options: { selectedId?: string | null; sessionKey?: string; connected?: boolean } = {},
) {
  const [search, setSearch] = createSignal("");
  const { gateway, publish } = createApplicationGateway();
  const request = createGatewayRequestMock(async () => {
    await discovered;
    return {
      servers: [
        {
          serverName: "parts",
          label: "Parts library",
          entrypoints: [
            {
              title: "Library",
              toolName: "library",
              resourceUri: "ui://parts/library",
              entrypoint: { type: "global" },
            },
          ],
        },
      ],
    };
  });
  publish({
    ...gateway.snapshot,
    client: createTestGatewayClient(request),
    phase: options.connected === false ? "stopped" : "connected",
    sessionKey: options.sessionKey ?? "agent:main:one",
    hello: gatewayHelloForMethods(["mcp.app.discover"]),
  });
  // The fixture supplies the discovery, navigation and selection capabilities used here.
  const context = {
    gateway,
    navigate: vi.fn(),
    agentSelection: {
      state: { selectedId: options.selectedId === undefined ? "main" : options.selectedId },
      subscribe: () => () => {},
    },
    sessions: { describe: async () => ({ session: { key: "agent:main:one" } }) },
  } as unknown as ApplicationContext;
  const mounted = mountSolid(() => <AppsPage appSearch={search()} />, {
    wrapper: createSolidApplicationContextProvider(context).wrapper,
  });
  return { ...mounted, setSearch, request };
}

it("loads app view and conversation alongside discovery, retries errors, and retires a closed route", async () => {
  const first = createDeferred();
  const retry = createDeferred();
  const discovered = createDeferred();
  const appView = createDeferred<typeof import("../../components/mcp-app-view.tsx")>();
  const preload = vi.spyOn(McpAppView, "preload").mockReturnValue(appView.promise);
  const started = vi.fn();
  function mockLoad(pending: Promise<void>) {
    // mock-isolation: Hold or reject the actual lazy region import at its external boundary.
    vi.doMock("./apps-conversation.tsx", async (importOriginal) => {
      started();
      await pending;
      return importOriginal<typeof import("./apps-conversation.tsx")>();
    });
  }
  mockLoad(first.promise);
  const mounted = mountApps(discovered.promise);
  const { container, setSearch, queryByRole } = mounted;
  const pane = () => container.querySelector("openclaw-chat-pane");
  await waitForSolid(() => expect(container.querySelector(".apps-page")).not.toBeNull());
  expect(started).not.toHaveBeenCalled();
  expect(preload).not.toHaveBeenCalled();

  setSearch("?server=parts&tool=library");
  await waitForSolid(() => expect(started).toHaveBeenCalledOnce());
  expect(preload).toHaveBeenCalledOnce();
  expect(queryByRole("status")?.textContent).toContain("Loading");
  expect(pane()).toBeNull();
  appView.reject(new Error("App view preload failed"));
  await expect(appView.promise).rejects.toThrow("App view preload failed");
  await waitForSolid(() => {
    expect(queryByRole("status")?.textContent).toContain("Loading");
    expect(queryByRole("alert")).toBeNull();
  });
  first.reject(new Error("Conversation download failed"));
  await waitForSolid(() =>
    expect(queryByRole("alert")?.textContent).toContain("Conversation download failed"),
  );

  mockLoad(retry.promise);
  mounted.getByRole("button", { name: "Try again" }).click();
  await waitForSolid(() => expect(started).toHaveBeenCalledTimes(2));
  expect(pane()).toBeNull();
  setSearch("");
  await waitForSolid(() => expect(container.querySelector(".apps-page")).not.toBeNull());
  retry.reject(new Error("Retired conversation download"));
  await expect(import("./apps-conversation.tsx")).rejects.toThrow();
  await waitForSolid(() => expect(queryByRole("alert")).toBeNull());

  mockLoad(Promise.resolve());
  setSearch("?server=parts&tool=library");
  await waitForSolid(() => expect(started).toHaveBeenCalledTimes(3));
  expect(pane()).toBeNull();
  discovered.resolve();
  await waitForSolid(() =>
    expect(pane()).toMatchObject({
      className: "mcp-app-conversation",
      paneId: "plugin-app",
      presentationId: "plugin-app:agent:main:one",
      mcpAppLaunch: { sessionKey: "agent:main:one", serverName: "parts" },
    }),
  );
  const conversation = pane()!;
  setSearch("?server=parts&tool=library&path=/updated");
  await waitForSolid(() => expect(conversation.mcpAppLaunch?.deepLink).toBe("/updated"));
  expect(pane()).toBe(conversation);
  expect(queryByRole("alert")).toBeNull();
});

it("discovers the session's agent while selection is switching", async () => {
  const discovered = createDeferred();
  const mounted = mountApps(discovered.promise, {
    selectedId: "claude",
    sessionKey: "agent:main:main",
  });
  mounted.setSearch("?server=parts&tool=library");

  await waitForSolid(() => expect(mounted.request).toHaveBeenCalledOnce());
  expect(mounted.request).toHaveBeenCalledWith("mcp.app.discover", {
    sessionKey: "agent:main:main",
    agentId: "main",
  });
  discovered.resolve();
  await waitForSolid(() =>
    expect(mounted.container.querySelector("openclaw-chat-pane")?.mcpAppLaunch).toMatchObject({
      sessionKey: "agent:main:main",
      agentId: "main",
      serverName: "parts",
    }),
  );
});

afterEach(() => {
  cleanupSolid();
  vi.restoreAllMocks();
  vi.doUnmock("./apps-conversation.tsx");
});

it("names the page with one level-one heading above the hero", () => {
  const page = mountApps(Promise.resolve(), { connected: false, selectedId: null });
  flush();
  expect(page.getByRole("heading", { level: 1, name: "Apps" })).toBeTruthy();
  expect(page.container.querySelectorAll("h1")).toHaveLength(1);
  expect(page.getByRole("heading", { level: 2, name: "Take OpenClaw everywhere" })).toBeTruthy();
});
