import { createRenderEffect, createSignal, onCleanup } from "solid-js";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ApplicationContext } from "../app/context.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import {
  createApplicationGateway,
  createSolidApplicationContextProvider,
} from "../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import type { McpAppOpenDetail } from "./mcp-app-launch.ts";
import { registerMcpAppUnmountTarget } from "./mcp-app-unmount.ts";
import type { McpAppViewProps } from "./mcp-app-view-types.ts";
import { McpAppPanel } from "./solid/mcp-app-panel.tsx";

const viewLoad = vi.hoisted(() => ({
  ...Promise.withResolvers<void>(),
  started: vi.fn(),
}));

// mock-isolation: Exercise panel retirement without registering the real iframe protocol view.
vi.mock("./mcp-app-view.tsx", async () => {
  viewLoad.started();
  await viewLoad.promise;
  const fields = ["sessionKey", "agentId", "viewId", "title", "deepLink"] as const;
  return {
    McpAppView: (props: Pick<McpAppViewProps, (typeof fields)[number]>) => {
      const view = document.createElement("mcp-app-view");
      onCleanup(registerMcpAppUnmountTarget(view));
      createRenderEffect(
        () => Object.fromEntries(fields.map((key) => [key, props[key]])),
        (values) => void Object.assign(view, values),
      );
      return view;
    },
  };
});

it("retains the old app and its launch target until teardown finishes", async () => {
  const request = vi.fn(async (_method: string, params: { serverName: string }) => ({
    viewId: `${params.serverName}-view`,
  }));
  const client = { request } as unknown as NonNullable<ApplicationGateway["snapshot"]["client"]>;
  const application = createApplicationGateway();
  application.publish({ ...application.gateway.snapshot, client, phase: "connected" });
  const context = { gateway: application.gateway } as ApplicationContext;
  const launchFor = (name: string): McpAppOpenDetail => ({
    owner: client,
    sessionKey: `agent:${name}:session`,
    agentId: name,
    serverName: name,
    entrypoint: {
      toolName: "open",
      title: `${name} app`,
      resourceUri: `ui://${name}/app`,
      entrypoint: { type: "global" },
    },
  });
  const firstLaunch = launchFor("a");
  const target = { sessionKey: "agent:a:session", agentId: "a", viewId: "a-view" };
  const updated = { deepLink: "/second", title: "Updated app" };
  const [launch, setLaunch] = createSignal(firstLaunch);
  const { container } = mountSolid(
    () => <McpAppPanel launch={launch()} observeRetirement={() => () => {}} />,
    {
      wrapper: createSolidApplicationContextProvider(context).wrapper,
    },
  );
  await waitForSolid(() => expect(viewLoad.started).toHaveBeenCalledOnce());
  expect(request).not.toHaveBeenCalled();
  setLaunch({ ...firstLaunch, deepLink: "/initial" });
  flush();
  viewLoad.resolve();
  await waitForSolid(() => expect(container.querySelector("mcp-app-view")).not.toBeNull());
  const first = container.querySelector("mcp-app-view")!;
  expect(Reflect.get(first, "deepLink")).toBe("/initial");
  setLaunch({
    ...firstLaunch,
    deepLink: updated.deepLink,
    entrypoint: { ...firstLaunch.entrypoint, title: updated.title },
  });
  flush();
  expect(container.querySelector("mcp-app-view")).toBe(first);
  expect(first).toMatchObject(updated);
  expect(request).toHaveBeenCalledOnce();
  const retirement = createDeferred();
  const teardown = vi.fn(() => retirement.promise);
  Object.assign(first, { teardown, restartAfterTeardown: vi.fn() });
  setLaunch(launchFor("b"));
  flush();
  await waitForSolid(() => expect(request).toHaveBeenCalledTimes(2));
  expect(teardown).toHaveBeenCalledOnce();
  expect(container.querySelector("mcp-app-view")).toBe(first);
  expect(first).toMatchObject({ ...target, ...updated });

  retirement.resolve();
  await waitForSolid(() => {
    const second = container.querySelector("mcp-app-view");
    expect(second).not.toBe(first);
    expect(second).not.toBeNull();
    expect(second).toMatchObject({ sessionKey: "agent:b:session", viewId: "b-view" });
  });
  expect(first.isConnected).toBe(false);
});
