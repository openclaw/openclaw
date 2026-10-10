/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ShellGatewayOwner, type ShellGatewayHost } from "./app-shell-gateway.ts";
import type { ApplicationContext } from "./context.ts";
const calls = vi.hoisted(() => ({ created: vi.fn(), disposed: vi.fn() }));
// mock-isolation: test pending-import ownership without loading the DOM renderer, CSS, or observers.
vi.mock("./ui-annotations.ts", () => ({
  UiAnnotations: class {
    constructor(...args: unknown[]) {
      calls.created(...args);
    }
    dispose() {
      calls.disposed();
    }
  },
}));
let owner: ShellGatewayOwner;
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
});
afterEach(() => {
  owner?.dispose();
  vi.restoreAllMocks();
});
function setup() {
  const client = {};
  const context = {
    gateway: { snapshot: { client, phase: "connected", selfUser: { id: "person" } } },
  } as unknown as ApplicationContext;
  const host: ShellGatewayHost = Object.assign(document.createElement("div"), {
    context,
    activeSessionKey: "agent:main:a",
    routeState: {},
    desktopNavigationExpanded: false,
    lastLocalePrefSignature: null,
    outboxStoreImport: { load: async () => undefined },
    observeDeletedSessions() {},
    recoverDeletedActiveSession() {},
    selectChatSession() {},
    requestUpdate() {},
  });
  owner = new ShellGatewayOwner(host);
  return (kind = "annotate", sessionKey = "agent:main:a") =>
    owner.handleGatewayEvent({
      type: "event",
      event: "ui.command",
      payload: {
        sessionKey,
        command: { kind, annotations: [{ target: { control: "side-panel" }, text: "Here" }] },
      },
    });
}
it("ignores off-session annotate and clear before changing the current guide", async () => {
  const send = setup();
  send();
  await vi.dynamicImportSettled();
  expect(calls.created).toHaveBeenCalledOnce();
  send("annotations-clear", "agent:main:b");
  send("annotate", "agent:main:b");
  await vi.dynamicImportSettled();
  expect(calls.disposed).not.toHaveBeenCalled();
  expect(calls.created).toHaveBeenCalledOnce();
});
it("does not revive a pending import after the tab is hidden and shown", async () => {
  const send = setup();
  send();
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  document.dispatchEvent(new Event("visibilitychange"));
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  await vi.dynamicImportSettled();
  expect(calls.created).not.toHaveBeenCalled();
});
it("clearing a pending import prevents a late guide", async () => {
  const send = setup();
  send();
  send("annotations-clear");
  await vi.dynamicImportSettled();
  expect(calls.created).not.toHaveBeenCalled();
});
