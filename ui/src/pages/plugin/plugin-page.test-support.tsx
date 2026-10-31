import { createRouter, definePage } from "@openclaw/uirouter";
import { createSignal } from "solid-js";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import { createShellConfigFixture } from "../../app/app-host.test-support.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { mountSolid, type MountSolidOptions } from "../../test-helpers/mount-solid.ts";
import {
  createApplicationGateway,
  createSolidApplicationContextProvider,
} from "../../test-helpers/solid-application-context.tsx";
import { flush } from "../../test-helpers/solid-settle.ts";
import { PluginPage } from "./plugin-page.tsx";

type Config = ReturnType<typeof createShellConfigFixture>["current"];
export function pluginConfig(
  pluginFrameGrants: Config["pluginFrameGrants"] = [
    { pluginId: "external-plugin", path: "/plugins/external", match: "prefix" },
  ],
): Config {
  return { ...createShellConfigFixture().current, embedSandboxMode: "scripts", pluginFrameGrants };
}

export function createPage(
  controlUiTabs: GatewayHelloOk["controlUiTabs"],
  client: GatewayBrowserClient | null = null,
  configure: (
    gateway: ReturnType<typeof createApplicationGateway>["gateway"],
    hello: GatewayHelloOk,
  ) => Partial<ApplicationContext> = () => ({}),
  container?: MountSolidOptions["container"],
) {
  const { gateway, publish } = createApplicationGateway();
  const hello: GatewayHelloOk = {
    type: "hello-ok",
    protocol: 3,
    auth: { role: "operator", scopes: ["operator.write"] },
    controlUiTabs,
  };
  const snapshot = gateway.snapshot;
  Object.assign(snapshot, { client, phase: "connected", hello, sessionKey: "main" });
  const router = createRouter({
    routes: [definePage({ id: "plugin", path: "/plugin", component: () => ({}) })],
  });
  const context = {
    gateway,
    config: createShellConfigFixture(),
    router,
    ...configure(gateway, hello),
  } as ApplicationContext;
  const tab = controlUiTabs?.[0];
  const [props, setProps] = createSignal({ pluginId: tab?.pluginId, tabId: tab?.id });
  const view = mountSolid(() => <PluginPage pluginId={props().pluginId} tabId={props().tabId} />, {
    container,
    wrapper: createSolidApplicationContextProvider(context).wrapper,
  });
  return {
    ...view,
    gateway,
    hello,
    snapshot,
    setProps,
    page: view.container.querySelector("openclaw-plugin-page")!,
    notify: () => {
      publish(snapshot);
      flush();
    },
    dispose: () => {
      view.unmount();
      router.stop();
    },
  };
}
