import { createRouter, definePage } from "@openclaw/uirouter";
import type { JSX } from "@solidjs/web";
import { createComponent, createRoot, Show } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferredCore } from "../../../src/shared/deferred.ts";
import type { SolidRouteProps } from "../app-route-types.tsx";
import { registerMcpAppUnmountTarget } from "../components/mcp-app-unmount.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import type { ApplicationRuntime } from "./bootstrap.ts";
import {
  createSolidControlUiReadiness,
  type SolidReadinessShell,
} from "./control-ui-readiness-solid.ts";
import { ControlUiReadiness, type ControlUiCommittedPresentation } from "./control-ui-readiness.ts";
import {
  disposeRouterOutlets,
  mountRouterOutlet,
  settleRouterOutlet,
} from "./router-outlet.test-support.tsx";

const element = (tag = "div") => document.createElement(tag);
const subscribe = () => () => {};
afterEach(() => {
  disposeRouterOutlets();
  vi.unstubAllGlobals();
});

function fixture() {
  const root = element("openclaw-app");
  const owner = new ControlUiReadiness(root);
  onTestFinished(() => owner.disconnect());
  const runtime = {
    context: {
      gateway: { connectionRevision: 1, snapshot: { phase: "connected", client: null }, subscribe },
      sessions: {
        canonicalListRevision: 1,
        state: { result: { sessions: [] }, loading: false },
        subscribe,
      },
    },
    router: {
      subscribe,
      getState: () => ({ status: "success", matches: [], pendingMatches: [] }),
    },
  } as unknown as ApplicationRuntime;
  return { owner, root, runtime };
}

it("publishes the new generation only after the retiring MCP route releases its replacement", async () => {
  const { owner, runtime, root } = fixture();
  const teardown = createDeferredCore();
  const previousView = Object.assign(element(), {
    teardown: () => teardown.promise,
    restartAfterTeardown: () => {},
  });
  onTestFinished(registerMcpAppUnmountTarget(previousView));
  const destination = Object.assign(element(), { textContent: "Debug" });
  destination.dataset.destination = "";
  type RouteData = { ready: boolean };
  type RouteModule = { renderSolid: (props: SolidRouteProps<RouteData>) => JSX.Element };
  const page = (id: "about" | "debug", renderSolid: RouteModule["renderSolid"]) =>
    definePage<"about" | "debug", Record<string, never>, RouteModule, RouteData>({
      id,
      path: `/${id}`,
      component: () => ({ renderSolid }),
      loader: () => ({ ready: true }),
    });
  const router = createRouter<"about" | "debug", Record<string, never>, RouteModule, RouteData>({
    routes: [
      page("about", (props) =>
        createComponent(Show, {
          get when() {
            return props.data;
          },
          children: () => previousView,
        }),
      ),
      page("debug", () => destination),
    ],
  });
  const outlet = mountRouterOutlet({ router });
  try {
    await router.navigate("about", {});
    await outlet.settlePresentation();
    owner.connect({ ...runtime, router }, async () => ({
      kind: (await outlet.settlePresentation()) ? "shell" : "loading",
      navigationVisible: false,
    }));
    owner.commitRoot();
    await router.navigate("debug", {});
    await settleRouterOutlet(outlet);
    expect(outlet.contains(previousView)).toBe(true);
    expect(outlet.querySelector("[data-destination]")).toBeNull();
    expect(outlet.presentationSettled).toBe(false);
    expect(owner.hook.snapshot().routeReady).toBe(false);
    expect(root.hasAttribute("data-openclaw-ready")).toBe(false);
    teardown.resolve();
    await waitForSolid(() =>
      expect(root.getAttribute("data-openclaw-ready")).toBe(
        String(owner.hook.snapshot().generation),
      ),
    );
    expect(outlet.contains(previousView)).toBe(false);
    expect(outlet.querySelector("[data-destination]")?.textContent).toBe("Debug");
    expect(outlet.presentationSettled).toBe(true);
    expect(owner.hook.snapshot().routeReady).toBe(true);
  } finally {
    teardown.resolve();
    outlet.dispose();
    router.stop();
  }
});

it("does not publish a route commit while its adapter still shows loading", async () => {
  const { owner, runtime, root } = fixture();
  const entered = createDeferredCore();
  owner.connect(runtime, async () => {
    entered.resolve();
    return { kind: "loading", navigationVisible: true };
  });
  owner.commitRoot();
  await entered.promise;
  await Promise.resolve();
  await Promise.resolve();
  expect(owner.hook.snapshot().routeReady).toBe(false);
  expect(root.hasAttribute("data-openclaw-ready")).toBe(false);
});

it.each(["resolve", "reject"])(
  "settles a replacement before its retired adapter can %s",
  async (outcome) => {
    const { owner, root, runtime } = fixture();
    const obsolete = createDeferredCore<ControlUiCommittedPresentation>();
    owner.connect(runtime, () => obsolete.promise);
    owner.commitRoot();
    owner.connect({ ...runtime }, async () => ({ kind: "shell", navigationVisible: false }));
    owner.commitRoot();
    const generation = owner.hook.snapshot().generation;
    const expectCurrent = () => {
      expect(owner.hook.snapshot().ready).toBe(true);
      expect(root.getAttribute("data-openclaw-ready")).toBe(String(generation));
    };
    await waitForSolid(expectCurrent);
    if (outcome === "reject") {
      obsolete.reject(new Error("retired renderer"));
    } else {
      obsolete.resolve({ kind: "loading", navigationVisible: true });
    }
    await Promise.resolve();
    expectCurrent();
  },
);

it("does not advertise a retained terminal after it is detached", async () => {
  const { root, runtime } = fixture();
  const workspace = element();
  const terminal = Object.assign(element(), { available: true, updateComplete: Promise.resolve() });
  const shell: SolidReadinessShell = {
    element: element("section"),
    shellElement: workspace,
    readiness: undefined,
    activeSessionKey: "agent:main:main",
    navigationSidebar: Object.assign(element("nav"), { navigationVisible: false }),
    routeOutlet: Object.assign(element(), {
      presentationSettled: true,
      settlePresentation: async () => true,
    }),
    terminalPanel: terminal,
  };
  workspace.append(terminal);
  shell.element.append(workspace);
  root.append(shell.element);
  document.body.append(root);
  const { owner, dispose } = createRoot((disposeRoot) => ({
    dispose: disposeRoot,
    owner: createSolidControlUiReadiness(
      root,
      runtime,
      () => {},
      () => ({ shell, terminal }),
    ),
  }));
  onTestFinished(() => owner.disconnect());
  try {
    for (const [available, change] of [
      [true, () => {}],
      [false, () => terminal.remove()],
      [true, () => workspace.append(terminal)],
    ] as const) {
      change();
      owner.commitRoot();
      const expected = { routeReady: true, terminalActivationReady: available };
      await waitForSolid(() => expect(owner.hook.snapshot()).toMatchObject(expected));
    }
  } finally {
    dispose();
    root.remove();
  }
});
