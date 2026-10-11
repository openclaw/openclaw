import { createRenderEffect, createSignal } from "solid-js";
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
import { McpAppPanel } from "./mcp-app-panel.ts";
import type { McpAppViewProps } from "./mcp-app-view.ts";

// mock-isolation: Exercise panel retirement without registering the real iframe protocol view.
vi.mock("./mcp-app-view-registration.ts", () => ({
  McpAppView: (
    props: Pick<McpAppViewProps, "sessionKey" | "agentId" | "viewId" | "title" | "deepLink">,
  ) => {
    const view = document.createElement("mcp-app-view");
    createRenderEffect(
      () => ({
        sessionKey: props.sessionKey,
        agentId: props.agentId,
        viewId: props.viewId,
        title: props.title,
        deepLink: props.deepLink,
      }),
      (values) => {
        Object.assign(view, values);
      },
    );
    return view;
  },
}));

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
  const [launch, setLaunch] = createSignal(launchFor("first"));
  const { container } = mountSolid(() => <McpAppPanel launch={launch()} />, {
    wrapper: createSolidApplicationContextProvider(context).wrapper,
  });
  await waitForSolid(() => expect(container.querySelector("mcp-app-view")).not.toBeNull());
  const first = container.querySelector("mcp-app-view")!;
  const firstLaunch = launchFor("first");
  setLaunch({
    ...firstLaunch,
    deepLink: "/second",
    entrypoint: { ...firstLaunch.entrypoint, title: "Updated first app" },
  });
  flush();
  expect(container.querySelector("mcp-app-view")).toBe(first);
  expect(Reflect.get(first, "deepLink")).toBe("/second");
  expect(Reflect.get(first, "title")).toBe("Updated first app");
  expect(request).toHaveBeenCalledOnce();
  const retirement = createDeferred();
  const teardown = vi.fn(() => retirement.promise);
  Object.assign(first, { teardown, restartAfterTeardown: vi.fn() });
  setLaunch(launchFor("second"));
  flush();
  await waitForSolid(() => expect(request).toHaveBeenCalledTimes(2));
  expect(teardown).toHaveBeenCalledOnce();
  expect(container.querySelector("mcp-app-view")).toBe(first);
  expect(Reflect.get(first, "sessionKey")).toBe("agent:first:session");
  expect(Reflect.get(first, "agentId")).toBe("first");
  expect(Reflect.get(first, "viewId")).toBe("first-view");
  expect(Reflect.get(first, "deepLink")).toBe("/second");
  expect(Reflect.get(first, "title")).toBe("Updated first app");

  retirement.resolve();
  await waitForSolid(() => {
    const second = container.querySelector("mcp-app-view");
    expect(second).not.toBe(first);
    expect(second).not.toBeNull();
    expect(Reflect.get(second!, "sessionKey")).toBe("agent:second:session");
    expect(Reflect.get(second!, "viewId")).toBe("second-view");
  });
  expect(first.isConnected).toBe(false);
});
