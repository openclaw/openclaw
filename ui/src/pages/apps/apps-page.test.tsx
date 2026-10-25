/* @vitest-environment jsdom */

import { getQueriesForElement } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ApplicationContext } from "../../app/context-types.ts";
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

beforeEach(async () => {
  await i18n.setLocale("en");
});

function mountApps(discovered: Promise<void>) {
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
    phase: "connected",
    sessionKey: "agent:main:one",
    hello: gatewayHelloForMethods(["mcp.app.discover"]),
  });
  // The fixture supplies the discovery, navigation and selection capabilities used here.
  const context = {
    gateway,
    navigate: vi.fn(),
    agentSelection: { state: { selectedId: "main" }, subscribe: () => () => {} },
    sessions: { describe: async () => ({ session: { key: "agent:main:one" } }) },
  } as unknown as ApplicationContext;
  const mounted = mountSolid(() => <AppsPage appSearch={search()} />, {
    wrapper: createSolidApplicationContextProvider(context).wrapper,
  });
  return { ...mounted, setSearch };
}

it("loads conversation alongside discovery, retries errors, and retires a closed route", async () => {
  const first = createDeferred();
  const retry = createDeferred();
  const discovered = createDeferred();
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
  const { container, setSearch } = mounted;
  await waitForSolid(() => expect(container.querySelector(".apps-page")).not.toBeNull());
  expect(started).not.toHaveBeenCalled();

  setSearch("?server=parts&tool=library");
  await waitForSolid(() => expect(started).toHaveBeenCalledOnce());
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading");
  expect(container.querySelector("openclaw-chat-pane")).toBeNull();
  first.reject(new Error("Conversation download failed"));
  await waitForSolid(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Conversation download failed",
    ),
  );

  mockLoad(retry.promise);
  mounted.getByRole("button", { name: "Try again" }).click();
  await waitForSolid(() => expect(started).toHaveBeenCalledTimes(2));
  expect(container.querySelector("openclaw-chat-pane")).toBeNull();
  setSearch("");
  await waitForSolid(() => expect(container.querySelector(".apps-page")).not.toBeNull());
  retry.reject(new Error("Retired conversation download"));
  await expect(import("./apps-conversation.tsx")).rejects.toThrow();
  await waitForSolid(() => expect(container.querySelector('[role="alert"]')).toBeNull());

  mockLoad(Promise.resolve());
  setSearch("?server=parts&tool=library");
  await waitForSolid(() => expect(started).toHaveBeenCalledTimes(3));
  expect(container.querySelector("openclaw-chat-pane")).toBeNull();
  discovered.resolve();
  await waitForSolid(() =>
    expect(container.querySelector("openclaw-chat-pane")?.mcpAppLaunch).toMatchObject({
      sessionKey: "agent:main:one",
      serverName: "parts",
    }),
  );
  const pane = container.querySelector("openclaw-chat-pane")!;
  expect(pane.className).toBe("mcp-app-conversation");
  expect(pane.paneId).toBe("plugin-app");
  expect(pane.presentationId).toBe("plugin-app:agent:main:one");
  setSearch("?server=parts&tool=library&path=/updated");
  await waitForSolid(() => expect(pane.mcpAppLaunch?.deepLink).toBe("/updated"));
  expect(container.querySelector("openclaw-chat-pane")).toBe(pane);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

afterEach(() => {
  cleanupSolid();
  vi.doUnmock("./apps-conversation.tsx");
});

describe("AppsPage", () => {
  it("names the page with one level-one heading above the hero", () => {
    const provider = createSolidApplicationContextProvider({
      gateway: createApplicationGateway().gateway,
      agentSelection: {
        state: { selectedId: null },
        intentRevision: 0,
        subscribe: () => () => undefined,
      },
      navigate: () => undefined,
    } as unknown as ApplicationContext);
    const { container } = mountSolid(() => <AppsPage />, { wrapper: provider.wrapper });
    flush();

    const page = getQueriesForElement(container);
    expect(page.getByRole("heading", { level: 1, name: "Apps" })).toBeTruthy();
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(page.getByRole("heading", { level: 2, name: "Take OpenClaw everywhere" })).toBeTruthy();
  });

  it("asks for discovery with the agent the open session key names", async () => {
    // The selection advances on its own schedule, so a request built from both the
    // gateway's session key and the selected agent can name two different agents. The
    // Gateway refuses that pair with FORBIDDEN/SESSION_ACCESS_CHANGED.
    const { gateway, publish } = createApplicationGateway();
    const request = createGatewayRequestMock(async () => ({ servers: [], onboarding: [] }));
    publish({
      ...gateway.snapshot,
      client: createTestGatewayClient(request),
      phase: "connected",
      sessionKey: "agent:main:main",
      hello: gatewayHelloForMethods(["mcp.app.discover"]),
    });
    const context = {
      gateway,
      navigate: vi.fn(),
      agentSelection: { state: { selectedId: "claude" }, subscribe: () => () => {} },
      sessions: { describe: async () => ({ session: { key: "agent:main:main" } }) },
    } as unknown as ApplicationContext;
    mountSolid(() => <AppsPage appSearch="?server=parts&tool=library" />, {
      wrapper: createSolidApplicationContextProvider(context).wrapper,
    });
    const isDiscovery = ([method]: unknown[]) => method === "mcp.app.discover";
    await waitForSolid(() => expect(request.mock.calls.some(isDiscovery)).toBe(true));

    const discover = request.mock.calls.find(isDiscovery);
    const target = discover?.[1] as { sessionKey: string; agentId?: string } | undefined;
    expect(target?.sessionKey).toBe("agent:main:main");
    expect(target?.agentId).toBe("main");
  });
});
