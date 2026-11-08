import { createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import type { McpAppSettings } from "../../../src/shared/mcp-app-extensions.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ApplicationContext } from "../app/context.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../test-helpers/gateway-client.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import {
  createApplicationGateway,
  createSolidApplicationContextProvider,
} from "../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import type { McpAppOpenDetail } from "./mcp-app-launch.ts";
import { McpAppPanel } from "./solid/mcp-app-panel.tsx";

function settings(name: string): McpAppSettings {
  return {
    schema: { type: "object", properties: { name: { type: "string", title: "Name" } } },
    values: { name },
  };
}

function panel(request: GatewayRequestHandler, finish: () => void) {
  const client = createTestGatewayClient(request);
  const application = createApplicationGateway();
  application.publish({ ...application.gateway.snapshot, client, phase: "connected" });
  const launch: McpAppOpenDetail = {
    owner: client,
    sessionKey: "agent:main:fixture",
    agentId: "main",
    serverName: "parts",
    settings: true,
    entrypoint: {
      toolName: "settings",
      title: "Parts settings",
      resourceUri: "ui://parts/settings",
      entrypoint: { type: "settings" },
    },
  };
  let replace!: () => void;
  const retirementListeners = new Set<() => void>();
  const mounted = mountSolid(
    () => {
      const [current, setCurrent] = createSignal(launch);
      replace = () => {
        for (const retire of retirementListeners) {
          retire();
        }
        setCurrent({ ...launch, serverName: "successor" });
      };
      return (
        <McpAppPanel
          launch={current()}
          observeRetirement={(retire) => {
            retirementListeners.add(retire);
            return () => retirementListeners.delete(retire);
          }}
        />
      );
    },
    {
      wrapper: createSolidApplicationContextProvider({
        gateway: application.gateway,
      } as ApplicationContext).wrapper,
    },
  );
  onTestFinished(finish);
  const input = () => mounted.container.querySelector<HTMLInputElement>("input")!;
  const form = () => mounted.container.querySelector("form");
  const submit = () => mounted.container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const alert = () => mounted.container.querySelector('[role="alert"]');
  const edit = (name: string) => {
    const field = input();
    field.value = name;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    return field;
  };
  const save = () =>
    form()!.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
  const expectValue = (value: string) => waitForSolid(() => expect(input()?.value).toBe(value));
  const expectError = (error: string) =>
    waitForSolid(() => expect(alert()?.textContent).toContain(error));
  return {
    ...mounted,
    replace,
    input,
    form,
    submit,
    alert,
    edit,
    save,
    expectValue,
    expectError,
  };
}

it("shows a held settings read, reports its failure, and retries the current app", async () => {
  const read = createDeferred<McpAppSettings>();
  const request = vi.fn().mockReturnValueOnce(read.promise).mockResolvedValue(settings("Library"));
  const view = panel(request, () => read.resolve(settings("Library")));
  await waitForSolid(() => expect(view.container.querySelector('[role="status"]')).not.toBeNull());
  expect(view.container.querySelector("form")).toBeNull();
  read.reject(new Error("Settings unavailable"));
  await view.expectError("Settings unavailable");
  [...view.container.querySelectorAll("button")]
    .find((button) => button.textContent?.trim() === "Try again")!
    .click();
  await view.expectValue("Library");
  expect(view.alert()).toBeNull();
});

it("retains the edited form while saving, reconciles accepted values, and keeps rejected edits retryable", async () => {
  const retry = createDeferred<{ toolResult?: { isError?: boolean } }>();
  const request = vi
    .fn()
    .mockResolvedValueOnce(settings("Library"))
    .mockRejectedValueOnce(new Error("Save unavailable"))
    .mockReturnValueOnce(retry.promise)
    .mockResolvedValue(settings("Stored"));
  const view = panel(request, () => retry.resolve({}));
  await view.expectValue("Library");
  const form = view.form();
  const submit = view.submit();
  const input = view.edit("Shelves");
  view.save();
  await view.expectError("Save unavailable");
  expect(view.form()).toBe(form);
  expect(input.value).toBe("Shelves");
  await waitForSolid(() => expect(submit.disabled).toBe(false));
  view.save();
  await waitForSolid(() => {
    expect(submit.disabled).toBe(true);
    expect(view.alert()).toBeNull();
  });
  expect(view.form()).toBe(form);
  expect(input.value).toBe("Shelves");
  retry.resolve({});
  await view.expectValue("Stored");
  expect(view.input().disabled).toBe(false);
  expect(submit.disabled).toBe(true);
  expect(view.form()).toBe(form);
});

it.each(["read", "save"])(
  "retires a held %s without disturbing the editable successor",
  async (operation) => {
    const pending = createDeferred<McpAppSettings>();
    const request = vi.fn();
    if (operation === "save") {
      request.mockResolvedValueOnce(settings("Library"));
    }
    request.mockReturnValueOnce(pending.promise).mockResolvedValue(settings("Successor"));
    const settle = () =>
      operation === "read"
        ? pending.resolve(settings("Retired"))
        : pending.reject(new Error("Retired failure"));
    const view = panel(request, settle);
    if (operation === "save") {
      await view.expectValue("Library");
      view.edit("Pending");
      view.save();
      await waitForSolid(() => expect(view.input().disabled).toBe(true));
    } else {
      await waitForSolid(() =>
        expect(view.container.querySelector('[role="status"]')).not.toBeNull(),
      );
    }
    view.replace();
    await view.expectValue("Successor");
    const input = view.input();
    expect(input.disabled).toBe(false);
    view.edit("Successor draft");
    expect(view.submit().disabled).toBe(false);
    settle();
    await pending.promise.catch(() => {});
    await Promise.resolve();
    flush();
    expect(input.value).toBe("Successor draft");
    expect(view.alert()).toBeNull();
  },
);
