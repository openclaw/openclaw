import { afterEach, expect, it, vi } from "vitest";
import { boardWidget, callbacks, mount, settleCells, snapshot } from "./board-view.test-support.ts";
import { cleanupCells } from "./board-widget-cell.test-support.ts";
import "./board-view.tsx";

afterEach(cleanupCells);

async function openSettings(view: HTMLElementTagNameMap["openclaw-board-view"]) {
  view.lobby = true;
  await settleCells(view);
  view.querySelector<HTMLButtonElement>('[data-test-id="lobby-settings-open"]')!.click();
  await settleCells(view);
  return view.querySelector("openclaw-modal-dialog")!;
}
const click = (root: ParentNode, id: string) =>
  root.querySelector<HTMLButtonElement>(`[data-test-id="${id}"]`)!.click();
const state = (root: ParentNode) =>
  root.querySelector('[data-test-id="lobby-permission-state"]')?.textContent;
const requested = () =>
  boardWidget({
    grantState: "pending",
    declared: {
      netOrigins: ["https://weather.example.test"],
      tools: ["weather.read"],
      actionBindings: [
        {
          name: "play",
          actionId: "device-controls.audio",
          params: { nodeId: "studio-mac", operationId: "demo-operation" },
        },
      ],
    },
  });

it("opens permissions for an empty Lobby without inventing access or mutating it", async () => {
  const actions = callbacks();
  const view = await mount({ snapshot: snapshot({ widgets: [] }), callbacks: actions });
  expect(view.querySelector('[data-test-id="lobby-settings-open"]')).toBeNull();
  const panel = await openSettings(view);
  expect(panel.textContent).toContain("No additional access requested.");
  expect(panel.querySelector('[data-test-id="lobby-permission-allow"]')).toBeNull();
  expect(actions.grant).not.toHaveBeenCalled();
  panel.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click();
  await settleCells(view);
  expect(view.querySelector("openclaw-modal-dialog")).toBeNull();
});

it("shows exact scope and waits for Gateway state before reporting approval", async () => {
  let finish!: () => void;
  const grant = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const initial = snapshot({ widgets: [requested()] });
  const view = await mount({ snapshot: initial, callbacks: callbacks({ grant }) });
  const panel = await openSettings(view);
  expect(panel.textContent).toContain("https://weather.example.test");
  expect(panel.textContent).toContain("weather.read");
  expect(panel.textContent).toContain("studio-mac");
  expect(panel.textContent).not.toContain('{"nodeId"');
  expect(panel.textContent).toContain("device-controls.audio");
  expect(panel.textContent).toContain("Devices must be connected");
  click(panel, "lobby-permission-allow");
  click(panel, "lobby-permission-allow");
  await settleCells(view);
  expect(grant).toHaveBeenCalledExactlyOnceWith("alpha", "granted");
  expect(state(panel)).toContain("Awaiting approval");
  expect(
    panel.querySelector<HTMLButtonElement>('[data-test-id="lobby-permission-deny"]')!.disabled,
  ).toBe(true);
  finish();
  await settleCells(view);
  // A successful callback alone must not fabricate an acknowledged grant.
  expect(state(panel)).toContain("Awaiting approval");
  view.snapshot = { ...initial, revision: 2, widgets: [{ ...requested(), grantState: "granted" }] };
  await settleCells(view);
  expect(state(panel)).toContain("Access allowed");
  expect(panel.textContent).toContain("Revoke access");
});

it("uses the same persisted rejection for deny and revoke, including on remount", async () => {
  const initial = snapshot({ widgets: [requested()] });
  const grant = vi.fn(async () => undefined);
  const view = await mount({ snapshot: initial, callbacks: callbacks({ grant }) });
  const panel = await openSettings(view);
  click(panel, "lobby-permission-deny");
  await settleCells(view);
  expect(grant).toHaveBeenLastCalledWith("alpha", "rejected");
  view.snapshot = { ...initial, revision: 2, widgets: [{ ...requested(), grantState: "granted" }] };
  await settleCells(view);
  expect(panel.textContent).toContain("Revoke access");
  click(panel, "lobby-permission-deny");
  await settleCells(view);
  expect(grant).toHaveBeenCalledTimes(2);
  expect(grant).toHaveBeenLastCalledWith("alpha", "rejected");
  const rejected = {
    ...initial,
    revision: 3,
    widgets: [boardWidget({ ...requested(), grantState: "rejected" })],
  };
  view.snapshot = rejected;
  await settleCells(view);
  expect(state(panel)).toContain("Access denied");
  const reopened = await mount({ snapshot: rejected });
  expect(state(await openSettings(reopened))).toContain("Access denied");
});

it("preserves accepted state on failure, shows the actual error and allows retry", async () => {
  const grant = vi
    .fn()
    .mockRejectedValueOnce(new Error("Permission service unavailable"))
    .mockResolvedValue(undefined);
  const view = await mount({
    snapshot: snapshot({ widgets: [requested()] }),
    callbacks: callbacks({ grant }),
  });
  const panel = await openSettings(view);
  click(panel, "lobby-permission-allow");
  await settleCells(view);
  expect(panel.querySelector('[role="alert"]')?.textContent).toContain(
    "Permission service unavailable",
  );
  expect(state(panel)).toContain("Awaiting approval");
  click(panel, "lobby-permission-allow");
  await settleCells(view);
  expect(grant).toHaveBeenCalledTimes(2);
  expect(panel.querySelector('[role="alert"]')).toBeNull();
});

it("does not publish a retired connection's result into the new owner", async () => {
  let reject!: (error: Error) => void;
  const grant = vi.fn(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
  );
  const view = await mount({
    snapshot: snapshot({ widgets: [requested()] }),
    callbacks: callbacks({ grant }),
  });
  const panel = await openSettings(view);
  click(panel, "lobby-permission-allow");
  await settleCells(view);
  view.callbacks = callbacks();
  view.snapshot = snapshot({ sessionKey: "agent:other:lobby", widgets: [requested()] });
  reject(new Error("Old connection failed"));
  await settleCells(view);
  expect(panel.querySelector('[role="alert"]')).toBeNull();
  expect(
    panel.querySelector<HTMLButtonElement>('[data-test-id="lobby-permission-allow"]')!.disabled,
  ).toBe(false);
});

it("keeps permission controls read-only when the connection cannot grant", async () => {
  const actions = callbacks();
  const view = await mount({
    snapshot: snapshot({ widgets: [requested()] }),
    callbacks: actions,
    canGrant: false,
  });
  const panel = await openSettings(view);
  expect(panel.textContent).toContain("cannot change them");
  expect(
    panel.querySelector<HTMLButtonElement>('[data-test-id="lobby-permission-allow"]')!.disabled,
  ).toBe(true);
  click(panel, "lobby-permission-allow");
  await settleCells(view);
  expect(actions.grant).not.toHaveBeenCalled();
});

it("shows plugin-owned descriptions and exact scope as fields instead of JSON", async () => {
  const description =
    "Capture the selected screen and move its pointer. Requires Screen Recording and Accessibility permission on the target Mac.";
  const view = await mount({
    snapshot: snapshot({
      widgets: [
        boardWidget({
          grantState: "granted",
          declared: {
            tools: ["device-controls.pointer"],
            actionBindings: [
              {
                name: "move-pointer",
                actionId: "device-controls.pointer",
                params: { nodeId: "studio-mac", operation: "move" },
              },
            ],
          },
          declaredSummary: ['Action move: {"nodeId":"studio-mac","operation":"move"}'],
          capabilityDescriptions: { "device-controls.pointer": description },
        }),
      ],
    }),
  });
  const panel = await openSettings(view);
  expect(panel.textContent).toContain(description);
  expect(panel.textContent).toContain("studio-mac");
  expect(panel.textContent).not.toContain('{"nodeId"');
  expect(panel.querySelectorAll(".lobby-access__requests > section")).toHaveLength(1);
  expect(panel.querySelector("details")?.open).toBe(false);
  expect([...panel.querySelectorAll("dd")].map((item) => item.textContent)).toEqual([
    "device-controls.pointer",
    "studio-mac",
    "move",
  ]);
});

it("retires permission feedback when the component's requested scope is replaced", async () => {
  let reject!: (error: Error) => void;
  const grant = vi.fn(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
  );
  const view = await mount({
    snapshot: snapshot({ widgets: [requested()] }),
    callbacks: callbacks({ grant }),
  });
  const panel = await openSettings(view);
  click(panel, "lobby-permission-allow");
  await settleCells(view);
  view.snapshot = snapshot({ revision: 2, widgets: [{ ...requested(), revision: 2 }] });
  reject(new Error("Previous component revision failed"));
  await settleCells(view);
  expect(panel.querySelector('[role="alert"]')).toBeNull();
  expect(
    panel.querySelector<HTMLButtonElement>('[data-test-id="lobby-permission-allow"]')!.disabled,
  ).toBe(false);
});

it("limits component-page access to the opened component without changing grants", async () => {
  const actions = callbacks();
  const view = await mount({
    snapshot: snapshot({
      widgets: [
        requested(),
        boardWidget({ ...requested(), name: "other", title: "Other component", position: 1 }),
      ],
    }),
    callbacks: actions,
  });
  view.lobby = true;
  await settleCells(view);
  view.querySelector<HTMLButtonElement>(".lobby-component__toggle")!.click();
  await settleCells(view);
  const panel = await openSettings(view);
  expect(panel.textContent).not.toContain("Other component");
  expect(panel.querySelectorAll('[data-test-id="lobby-permission-state"]')).toHaveLength(1);
  expect(actions.grant).not.toHaveBeenCalled();
});
