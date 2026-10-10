import { createRouter, definePage } from "@openclaw/uirouter";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../src/shared/deferred.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import type { ApplicationRuntime } from "./bootstrap.ts";
import {
  ControlUiReadiness,
  type ControlUiCommittedPresentation,
  type ControlUiReadinessOutlet,
} from "./control-ui-readiness.ts";
import "./router-outlet.ts";

const owners: ControlUiReadiness[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.disconnect();
  }
  vi.unstubAllGlobals();
});

function fixture() {
  const root = document.createElement("openclaw-app");
  const owner = new ControlUiReadiness(root);
  owners.push(owner);
  // The owner reads these runtime contracts; transports and rendering are separate boundaries.
  const runtime = {
    context: {
      gateway: {
        connectionRevision: 1,
        snapshot: { phase: "connected", client: null },
        subscribe: () => () => {},
      },
      sessions: {
        canonicalListRevision: 1,
        state: { result: { sessions: [] }, loading: false },
        subscribe: () => () => {},
      },
      basePath: "",
      config: { current: {} },
    },
    router: {
      subscribe: () => () => {},
      getState: () => ({ status: "success", matches: [], pendingMatches: [] }),
    },
  } as unknown as ApplicationRuntime;
  return { owner, root, runtime };
}

it("publishes the new generation only after the retiring MCP route releases its replacement", async () => {
  const { owner, runtime, root } = fixture();
  const teardown = createDeferredCore();
  const previousView = Object.assign(document.createElement("mcp-app-view"), {
    teardown: () => teardown.promise,
    restartAfterTeardown: () => {},
  });
  const destination = document.createElement("div");
  destination.dataset.destination = "";
  destination.textContent = "Debug";
  type RouteData = { ready: boolean };
  type RouteModule = { render: (data: RouteData | undefined) => Node | null };
  const router = createRouter<"about" | "debug", Record<string, never>, RouteModule, RouteData>({
    routes: [
      definePage<"about" | "debug", Record<string, never>, RouteModule, RouteData>({
        id: "about",
        path: "/about",
        component: () => ({
          render: (data) => (data ? previousView : null),
        }),
        loader: () => ({ ready: true }),
      }),
      definePage<"about" | "debug", Record<string, never>, RouteModule, RouteData>({
        id: "debug",
        path: "/debug",
        component: () => ({ render: () => destination }),
        loader: () => ({ ready: true }),
      }),
    ],
  });
  const outlet = document.createElement("openclaw-router-outlet") as ControlUiReadinessOutlet & {
    router: typeof router;
    updateComplete: Promise<boolean>;
  };
  outlet.router = router;
  document.body.append(outlet);
  let observer: MutationObserver | undefined;
  try {
    await router.navigate("about", {});
    await outlet.settlePresentation();
    owner.connect({ ...runtime, router }, async () => ({
      kind: (await outlet.settlePresentation()) ? "shell" : "loading",
      navigationVisible: false,
    }));
    owner.commitRoot();
    await router.navigate("debug", {});
    await settleLitElement(outlet);
    expect(outlet.querySelector("mcp-app-view")).not.toBeNull();
    expect(outlet.querySelector("[data-destination]")).toBeNull();
    expect(outlet.presentationSettled).toBe(false);
    expect(owner.hook.snapshot().routeReady).toBe(false);
    expect(root.hasAttribute("data-openclaw-ready")).toBe(false);
    const published = new Promise<string>((resolve) => {
      observer = new MutationObserver(() => {
        const generation = root.getAttribute("data-openclaw-ready");
        if (generation !== null) {
          observer?.disconnect();
          resolve(generation);
        }
      });
      observer.observe(root, { attributes: true, attributeFilter: ["data-openclaw-ready"] });
    });
    teardown.resolve();
    expect(await published).toBe(String(owner.hook.snapshot().generation));
    expect(outlet.querySelector("mcp-app-view")).toBeNull();
    expect(outlet.querySelector("[data-destination]")?.textContent).toBe("Debug");
    expect(outlet.presentationSettled).toBe(true);
    expect(owner.hook.snapshot().routeReady).toBe(true);
  } finally {
    observer?.disconnect();
    teardown.resolve();
    outlet.remove();
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
    const entered = createDeferredCore();
    owner.connect({ ...runtime }, async () => {
      entered.resolve();
      return { kind: "shell", navigationVisible: false };
    });
    owner.commitRoot();
    const generation = owner.hook.snapshot().generation;
    await entered.promise;
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(owner.hook.snapshot().ready).toBe(true);
    expect(root.getAttribute("data-openclaw-ready")).toBe(String(generation));
    if (outcome === "reject") {
      obsolete.reject(new Error("retired renderer"));
    } else {
      obsolete.resolve({ kind: "loading", navigationVisible: true });
    }
    await Promise.resolve();
    expect(owner.hook.snapshot().ready).toBe(true);
    expect(root.getAttribute("data-openclaw-ready")).toBe(String(generation));
  },
);
