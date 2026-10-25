import { createRoot } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferredCore } from "../../../src/shared/deferred.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import type { ApplicationRuntime } from "./bootstrap.ts";
import {
  createSolidControlUiReadiness,
  type SolidReadinessShell,
} from "./control-ui-readiness-solid.ts";
import { ControlUiReadiness, type ControlUiCommittedPresentation } from "./control-ui-readiness.ts";

const element = (tag = "div") => document.createElement(tag);
const subscribe = () => () => {};

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

function mountReadinessShell(overrides: Partial<SolidReadinessShell> = {}) {
  const { root, runtime } = fixture();
  const workspace = element();
  const shell: SolidReadinessShell = {
    element: element("section"),
    shellElement: workspace,
    readiness: undefined,
    activeSessionKey: "agent:main:main",
    workspaceChromeVisible: false,
    navigationSidebar: Object.assign(element("nav"), { navigationVisible: false }),
    routeOutlet: Object.assign(element(), {
      presentationSettled: true,
      settlePresentation: async () => true,
    }),
  };
  Object.defineProperties(shell, Object.getOwnPropertyDescriptors(overrides));
  shell.element.append(workspace);
  root.append(shell.element);
  document.body.append(root);
  const { owner, dispose } = createRoot((disposeRoot) => ({
    dispose: disposeRoot,
    owner: createSolidControlUiReadiness(
      root,
      runtime,
      () => {},
      () => ({ shell, terminal: shell.terminalPanel }),
    ),
  }));
  onTestFinished(() => {
    owner.disconnect();
    dispose();
    root.remove();
  });
  return { owner, root, workspace };
}

it("invalidates readiness on router changes and waits for the current adapter", async () => {
  const { owner, runtime, root } = fixture();
  const pending = createDeferredCore<ControlUiCommittedPresentation>();
  let notifyRouter = () => {};
  vi.spyOn(runtime.router, "subscribe").mockImplementation((listener) => {
    notifyRouter = () => listener(runtime.router.getState());
    return () => true;
  });
  onTestFinished(() => vi.restoreAllMocks());
  owner.connect(runtime, () => pending.promise);
  owner.commitRoot();
  expect(root.hasAttribute("data-openclaw-ready")).toBe(false);
  pending.resolve({ kind: "shell", navigationVisible: false });
  const expectReady = () =>
    expect(root.getAttribute("data-openclaw-ready")).toBe(String(owner.hook.snapshot().generation));
  await waitForSolid(expectReady);
  const generation = owner.hook.snapshot().generation;
  notifyRouter();
  expect(owner.hook.snapshot().generation).toBeGreaterThan(generation);
  expect(root.hasAttribute("data-openclaw-ready")).toBe(false);
  await waitForSolid(expectReady);
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

it("advertises a cold shell terminal only once its command owner is ready", async () => {
  const terminal = Object.assign(element(), { available: true, updateComplete: Promise.resolve() });
  const state = { activationReady: false };
  const { owner } = mountReadinessShell({
    terminalPanel: terminal,
    get terminalActivationReady() {
      return state.activationReady;
    },
  });
  for (const available of [false, true, false]) {
    state.activationReady = available;
    owner.commitRoot();
    const expected = { routeReady: true, terminalActivationReady: available };
    await waitForSolid(() => expect(owner.hook.snapshot()).toMatchObject(expected));
  }
});

it("waits for a visible lazy sidebar to connect, without blocking hidden navigation", async () => {
  const drawer = element();
  const sidebar = Object.assign(element("nav"), { navigationVisible: true });
  const { owner, root, workspace } = mountReadinessShell({
    navDrawerElement: drawer,
    workspaceChromeVisible: true,
    navigationSidebar: sidebar,
  });
  workspace.append(drawer);
  const get = customElements.get.bind(customElements);
  vi.spyOn(customElements, "get").mockImplementation((name) =>
    name === "openclaw-app-sidebar" ? HTMLElement : get(name),
  );
  onTestFinished(() => vi.restoreAllMocks());
  owner.commitRoot();
  await waitForSolid(() => expect(owner.hook.snapshot()).toMatchObject({ routeReady: false }));
  expect(root.hasAttribute("data-openclaw-ready")).toBe(false);
  drawer.append(sidebar);
  owner.commitRoot();
  await waitForSolid(() => expect(owner.hook.snapshot()).toMatchObject({ routeReady: true }));
  sidebar.remove();
  sidebar.navigationVisible = false;
  owner.commitRoot();
  await waitForSolid(() => expect(owner.hook.snapshot()).toMatchObject({ routeReady: true }));
});
