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
  let replace!: (next: McpAppOpenDetail) => void;
  const retirementListeners = new Set<() => void>();
  const mounted = mountSolid(
    () => {
      const [current, setCurrent] = createSignal(launch);
      replace = (next) => {
        for (const retire of retirementListeners) {
          retire();
        }
        setCurrent(next);
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
  onTestFinished(() => {
    finish();
    mounted.unmount();
  });
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
    launch,
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
  await waitForSolid(() => expect(request).toHaveBeenCalledOnce());
  expect(view.container.querySelector("form")).toBeNull();
  expect(view.container.querySelector('[role="status"]')).not.toBeNull();
  read.reject(new Error("Settings unavailable"));
  await view.expectError("Settings unavailable");
  [...view.container.querySelectorAll("button")]
    .find((button) => button.textContent?.trim() === "Try again")!
    .click();
  await view.expectValue("Library");
  expect(view.alert()).toBeNull();
  expect(request).toHaveBeenCalledTimes(2);
});

it("retains the edited form while saving, reconciles accepted values, and keeps rejected edits retryable", async () => {
  const save = createDeferred<{ toolResult?: { isError?: boolean } }>();
  const retry = createDeferred<{ toolResult?: { isError?: boolean } }>();
  const request = vi
    .fn()
    .mockResolvedValueOnce(settings("Library"))
    .mockReturnValueOnce(save.promise)
    .mockResolvedValueOnce(settings("Parts"))
    .mockRejectedValueOnce(new Error("Save unavailable"))
    .mockReturnValueOnce(retry.promise)
    .mockResolvedValue(settings("Shelves"));
  const view = panel(request, () => {
    save.resolve({});
    retry.resolve({});
  });
  await view.expectValue("Library");
  const form = view.form();
  const submit = view.submit();
  let input = view.input();
  const edit = (name: string) => {
    input = view.edit(name);
    view.save();
  };
  edit("Parts");
  await waitForSolid(() => expect(submit.disabled).toBe(true));
  expect(view.form()).toBe(form);
  expect(input.value).toBe("Parts");
  save.resolve({});
  await waitForSolid(() => expect(request).toHaveBeenCalledTimes(3));
  await waitForSolid(() => expect(view.input()?.disabled).toBe(false));
  expect(view.form()).toBe(form);
  expect(submit.disabled).toBe(true);
  edit("Shelves");
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
  await waitForSolid(() => expect(view.input()?.disabled).toBe(false));
  expect(view.form()).toBe(form);
});

it("replaces a held settings target immediately and ignores the old result", async () => {
  const oldRead = createDeferred<McpAppSettings>();
  const request = vi
    .fn()
    .mockReturnValueOnce(oldRead.promise)
    .mockResolvedValue(settings("Successor"));
  const view = panel(request, () => oldRead.resolve(settings("Retired")));
  await waitForSolid(() => expect(request).toHaveBeenCalledOnce());
  view.replace({ ...view.launch, serverName: "successor" });
  await view.expectValue("Successor");
  oldRead.resolve(settings("Retired"));
  await oldRead.promise;
  await Promise.resolve();
  flush();
  expect(view.input().value).toBe("Successor");
  expect(request).toHaveBeenCalledTimes(2);
});

it("lets a successor edit while an old save is held and ignores the retired failure", async () => {
  const save = createDeferred<never>();
  const request = vi
    .fn()
    .mockResolvedValueOnce(settings("Library"))
    .mockReturnValueOnce(save.promise)
    .mockResolvedValueOnce(settings("Successor"));
  const view = panel(request, () => save.reject(new Error("Retired failure")));
  await view.expectValue("Library");
  view.edit("Pending");
  view.save();
  await waitForSolid(() => expect(request).toHaveBeenCalledTimes(2));
  view.replace({ ...view.launch, serverName: "successor" });
  await view.expectValue("Successor");
  const input = view.input();
  expect(input.disabled).toBe(false);
  view.edit("Successor draft");
  expect(view.submit().disabled).toBe(false);
  save.reject(new Error("Retired failure"));
  await save.promise.catch(() => {});
  await Promise.resolve();
  flush();
  expect(input.value).toBe("Successor draft");
  expect(view.alert()).toBeNull();
  expect(request).toHaveBeenCalledTimes(3);
});
