/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { chatInputOwnerForContext } from "../../app/chat-input-owner.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { retainCreatedComposer } from "../new-session/creation-composer-registry.ts";
import { CreationComposer } from "../new-session/creation-composer.ts";
import { createMountedPanes } from "./chat-pane-mounted.test-support.ts";

afterEach(() => vi.unstubAllGlobals());
it.each([true, false])(
  "hands the completed Template draft to the active region (visible: %s)",
  async (visible) => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    const key = "agent:main:template-setup";
    const fixture = createMountedPanes([{ key, agentId: "main", kind: "direct", updatedAt: 1 }]);
    const { context } = fixture;
    const hello = sessionMutationGatewayHello();
    hello.auth = { ...hello.auth!, recoveryScope: "test-recovery-scope" };
    Object.assign(context.gateway.snapshot, { hello });
    const composer = new CreationComposer(context, "main", false, () => {});
    composer.setMessage("Draft during setup");
    composer.accept({ key, initialRun: { status: "idle" } }, { initializationPending: true });
    retainCreatedComposer(context, key, composer);
    expect(composer.canRecover()).toBe(true);
    const page = fixture.mount(key);
    page.active = true;
    const dock = fixture.mount(key);
    dock.inputRegion = "dock";
    dock.active = true;
    chatInputOwnerForContext(context).claim("dock");
    await Promise.all([page.updateComplete, dock.updateComplete]);
    page.presented = visible;
    dock.presented = visible;
    composer.accept({ key, initialRun: { status: "idle" } });
    context.chatSubmissions.notifyCreate();
    expect(page.state.chatMessage).toBe("");
    if (!visible) {
      expect(dock.state.chatMessage).toBe("");
      expect(composer.canAdopt()).toBe(true);
      dock.presented = true;
    }
    await waitForSolid(() => expect(dock.state.chatMessage).toBe("Draft during setup"));
    expect(page.state.chatMessage).toBe("");
  },
);

it("keeps a live dock's setup input independent of the page route", async () => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
  const key = "agent:main:template-setup";
  const fixture = createMountedPanes([{ key, agentId: "main", kind: "direct", updatedAt: 1 }]);
  const { context } = fixture;
  const hello = sessionMutationGatewayHello();
  hello.auth = { ...hello.auth!, recoveryScope: "test-recovery-scope" };
  Object.assign(context.gateway.snapshot, { hello });
  const composer = new CreationComposer(context, "main", false, () => {});
  composer.setMessage("Dock setup draft");
  composer.accept({ key, initialRun: { status: "idle" } }, { initializationPending: true });
  retainCreatedComposer(context, key, composer);
  // The live dock is A; provisional page presentation belongs to another route.
  context.chatSubmissions.beginCreate({
    creation: { sessionKey: key, admitted: true },
    composer,
    message: null,
    canDisplay: () => false,
  });
  const dock = fixture.mount(key);
  dock.inputRegion = "dock";
  dock.active = true;
  chatInputOwnerForContext(context).claim("dock");
  await dock.updateComplete;
  await waitForSolid(() => expect(dock.element.querySelector(".creation-composer")).not.toBeNull());
  expect(dock.element.querySelector("textarea")?.value).toBe("Dock setup draft");
  expect(composer.canAdopt()).toBe(false);
});

it("leaves an already completed setup draft for the selected input when panes mount", async () => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
  const key = "agent:main:template-setup";
  const fixture = createMountedPanes([{ key, agentId: "main", kind: "direct", updatedAt: 1 }]);
  const { context } = fixture;
  const hello = sessionMutationGatewayHello();
  hello.auth = { ...hello.auth!, recoveryScope: "test-recovery-scope" };
  Object.assign(context.gateway.snapshot, { hello });
  const composer = new CreationComposer(context, "main", false, () => {});
  composer.setMessage("Completed before mount");
  composer.accept({ key, initialRun: { status: "idle" } });
  retainCreatedComposer(context, key, composer);
  chatInputOwnerForContext(context).claim("dock");
  const page = fixture.mount(key);
  page.active = false;
  page.presented = false;
  await waitForSolid(() => expect(page.state).toBeDefined());
  expect(page.state.chatMessage).toBe("");
  const dock = fixture.mount(key);
  dock.inputRegion = "dock";
  dock.active = true;
  await dock.updateComplete;
  expect(page.state.chatMessage).toBe("");
  await waitForSolid(() => expect(dock.state.chatMessage).toBe("Completed before mount"));
});
