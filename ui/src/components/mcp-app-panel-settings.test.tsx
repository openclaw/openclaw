import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
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

function panel(request: GatewayRequestHandler) {
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
  return { ...mounted, launch, replace, application };
}

it("shows a held settings read, reports its failure, and retries the current app", async () => {
  const read = createDeferred<McpAppSettings>();
  const request = vi.fn().mockReturnValueOnce(read.promise).mockResolvedValue(settings("Library"));
  const view = panel(request);
  try {
    await waitForSolid(() => expect(request).toHaveBeenCalledOnce());
    expect(view.container.querySelector("form")).toBeNull();
    expect(view.container.querySelector('[role="status"]')).not.toBeNull();
    read.reject(new Error("Settings unavailable"));
    await waitForSolid(() =>
      expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
        "Settings unavailable",
      ),
    );
    [...view.container.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Try again")!
      .click();
    await waitForSolid(() =>
      expect(view.container.querySelector<HTMLInputElement>("input")?.value).toBe("Library"),
    );
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
  } finally {
    read.resolve(settings("Library"));
    view.unmount();
  }
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
  const view = panel(request);
  try {
    await waitForSolid(() => expect(view.container.querySelector("input")).not.toBeNull());
    const form = view.container.querySelector("form")!;
    let input = view.container.querySelector<HTMLInputElement>("input")!;
    const submit = view.container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    const edit = (name: string) => {
      input = view.container.querySelector<HTMLInputElement>("input")!;
      input.value = name;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      flush();
      form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    };
    edit("Parts");
    await waitForSolid(() => expect(submit.disabled).toBe(true));
    expect(view.container.querySelector("form")).toBe(form);
    expect(input.value).toBe("Parts");
    save.resolve({});
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(3));
    await waitForSolid(() =>
      expect(view.container.querySelector<HTMLInputElement>("input")?.disabled).toBe(false),
    );
    expect(view.container.querySelector("form")).toBe(form);
    expect(submit.disabled).toBe(true);
    edit("Shelves");
    await waitForSolid(() =>
      expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
        "Save unavailable",
      ),
    );
    expect(view.container.querySelector("form")).toBe(form);
    expect(input.value).toBe("Shelves");
    await waitForSolid(() => expect(submit.disabled).toBe(false));
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await waitForSolid(() => {
      expect(submit.disabled).toBe(true);
      expect(view.container.querySelector('[role="alert"]')).toBeNull();
    });
    expect(view.container.querySelector("form")).toBe(form);
    expect(input.value).toBe("Shelves");
    retry.resolve({});
    await waitForSolid(() =>
      expect(view.container.querySelector<HTMLInputElement>("input")?.disabled).toBe(false),
    );
    expect(view.container.querySelector("form")).toBe(form);
  } finally {
    save.resolve({});
    retry.resolve({});
    view.unmount();
  }
});

it("replaces a held settings target immediately and ignores the old result", async () => {
  const oldRead = createDeferred<McpAppSettings>();
  const request = vi
    .fn()
    .mockReturnValueOnce(oldRead.promise)
    .mockResolvedValue(settings("Successor"));
  const view = panel(request);
  try {
    await waitForSolid(() => expect(request).toHaveBeenCalledOnce());
    view.replace({ ...view.launch, serverName: "successor" });
    await waitForSolid(() =>
      expect(view.container.querySelector<HTMLInputElement>("input")?.value).toBe("Successor"),
    );
    oldRead.resolve(settings("Retired"));
    await oldRead.promise;
    await Promise.resolve();
    flush();
    expect(view.container.querySelector<HTMLInputElement>("input")?.value).toBe("Successor");
    expect(request).toHaveBeenCalledTimes(2);
  } finally {
    oldRead.resolve(settings("Retired"));
    view.unmount();
  }
});

it("lets a successor edit while an old save is held and ignores the retired failure", async () => {
  const save = createDeferred<never>();
  const request = vi
    .fn()
    .mockResolvedValueOnce(settings("Library"))
    .mockReturnValueOnce(save.promise)
    .mockResolvedValueOnce(settings("Successor"));
  const view = panel(request);
  try {
    await waitForSolid(() => expect(view.container.querySelector("input")).not.toBeNull());
    const oldInput = view.container.querySelector<HTMLInputElement>("input")!;
    oldInput.value = "Pending";
    oldInput.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    view.container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(2));
    view.replace({ ...view.launch, serverName: "successor" });
    await waitForSolid(() =>
      expect(view.container.querySelector<HTMLInputElement>("input")?.value).toBe("Successor"),
    );
    const input = view.container.querySelector<HTMLInputElement>("input")!;
    expect(input.disabled).toBe(false);
    input.value = "Successor draft";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(view.container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(
      false,
    );
    save.reject(new Error("Retired failure"));
    await save.promise.catch(() => {});
    await Promise.resolve();
    flush();
    expect(input.value).toBe("Successor draft");
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(request).toHaveBeenCalledTimes(3);
  } finally {
    save.reject(new Error("Retired failure"));
    view.unmount();
  }
});
