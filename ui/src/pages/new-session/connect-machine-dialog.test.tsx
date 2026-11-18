/* @vitest-environment jsdom */
import { getQueriesForElement } from "@solidjs/testing-library";
import { createMemo, createSignal } from "solid-js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import type { DevicePairJoinSetup } from "../../lib/device-pair-setup.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { ConnectMachineDialog } from "./connect-machine-dialog-view.tsx";
import { ConnectMachineSetupState } from "./connect-machine-dialog.ts";

const content = vi.hoisted(() => {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, release: () => resolve() };
});
vi.mock("./connect-machine-dialog-content.tsx", async (original) => {
  await content.promise;
  return original();
});

function code(id: string): DevicePairJoinSetup {
  return {
    setupId: id,
    setupCode: "SYNTHETIC",
    joinUrl: `https://gateway.example.test/j/${id}`,
    command: `openclaw connect https://gateway.example.test/j/${id} --session-host`,
    serviceCommand: `openclaw connect https://gateway.example.test/j/${id}`,
    installedCommand: `openclaw connect https://gateway.example.test/j/${id} --installed`,
    gatewayUrl: "wss://gateway.example.test",
    auth: "token",
    urlSource: "test",
    access: "node",
    expiresAtMs: 2_000_000_000_000,
  };
}

function mountSetup() {
  const gateway = {
    client: new GatewayBrowserClient({ url: "wss://gateway.example.test" }),
    connected: true,
  };
  let changed = () => {};
  const setup = new ConnectMachineSetupState(
    () => gateway,
    () => changed(),
  );
  const view = mountSolid(() => {
    const [revision, setRevision] = createSignal(0);
    changed = () => setRevision((value) => value + 1);
    const props = createMemo(() => {
      revision();
      return setup.view(true, () => {});
    });
    return (
      <>
        <button onClick={() => setup.start()}>Connect</button>
        <ConnectMachineDialog {...props()} />
      </>
    );
  });
  onTestFinished(() => setup.close());
  flush();
  // The modal moves its contents to the document's overlay surface.
  return { gateway, setup, view: { ...view, ...getQueriesForElement(document.body) } };
}

describe("machine connection presentation", () => {
  it("keeps the modal cancellable while its body loads and displays the current request on reopen", async () => {
    onTestFinished(content.release);
    const { gateway, view } = mountSetup();
    const retired = createDeferred<DevicePairJoinSetup>();
    const current = createDeferred<DevicePairJoinSetup>();
    const request = vi
      .spyOn(gateway.client, "request")
      .mockReturnValueOnce(retired.promise)
      .mockReturnValueOnce(current.promise);
    view.getByRole<HTMLButtonElement>("button", { name: "Connect" }).click();
    flush();
    expect(view.container.querySelector("openclaw-modal-dialog")).not.toBeNull();
    await waitForSolid(() => expect(request).toHaveBeenCalledOnce());
    view.getByRole<HTMLButtonElement>("button", { name: "Close" }).click();
    flush();
    expect(view.container.querySelector("openclaw-modal-dialog")).toBeNull();

    view.getByRole<HTMLButtonElement>("button", { name: "Connect" }).click();
    content.release();
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(2));
    await waitForSolid(() =>
      expect(view.getByRole("status").textContent).toBe("Creating a secure connection link…"),
    );
    current.resolve(code("current"));
    await waitForSolid(() => expect(view.getByText(code("current").command)).toBeDefined());
    retired.resolve(code("retired"));
    await waitForSolid(() => expect(view.queryByText(code("retired").command)).toBeNull());
  });

  it("opens while minting and retains the command and dialog through refresh failure and retry", async () => {
    const { gateway, view } = mountSetup();
    const initial = createDeferred<DevicePairJoinSetup>();
    const request = vi.spyOn(gateway.client, "request").mockReturnValueOnce(initial.promise);
    view.getByRole<HTMLButtonElement>("button", { name: "Connect" }).click();
    await waitForSolid(() =>
      expect(view.getByRole("status").textContent).toBe("Creating a secure connection link…"),
    );
    expect(view.getByRole<HTMLButtonElement>("button", { name: "Close" }).disabled).toBe(false);
    await waitForSolid(() => expect(request).toHaveBeenCalledOnce());
    initial.resolve(code("first"));
    await waitForSolid(() => expect(view.getByText(code("first").command)).toBeDefined());
    const dialog = view.container.querySelector("openclaw-modal-dialog");
    const refresh = createDeferred<DevicePairJoinSetup>();
    request.mockReturnValueOnce(refresh.promise);
    view.getByRole<HTMLButtonElement>("button", { name: "Create new code" }).click();
    await waitForSolid(() =>
      expect(view.getByRole<HTMLButtonElement>("button", { name: "Creating code…" }).disabled).toBe(
        true,
      ),
    );
    expect(view.getByText(code("first").command)).toBeDefined();
    expect(view.container.querySelector("openclaw-modal-dialog")).toBe(dialog);
    refresh.reject(new Error("Connection unavailable"));
    await waitForSolid(() =>
      expect(view.getByRole("alert").textContent).toContain("Connection unavailable"),
    );
    expect(view.getByText(code("first").command)).toBeDefined();

    request.mockResolvedValueOnce(code("replacement"));
    view.getByRole<HTMLButtonElement>("button", { name: "Create new code" }).click();
    await waitForSolid(() => expect(view.getByText(code("replacement").command)).toBeDefined());
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.queryByText(code("first").command)).toBeNull();
    expect(view.container.querySelector("openclaw-modal-dialog")).toBe(dialog);
  });

  it.each(["resolve", "reject"] as const)(
    "releases a dismissed request before a replacement connection, then ignores its late %s",
    async (outcome) => {
      const { gateway, view } = mountSetup();
      const retired = createDeferred<DevicePairJoinSetup>();
      const originalRequest = vi
        .spyOn(gateway.client, "request")
        .mockReturnValueOnce(retired.promise);
      view.getByRole<HTMLButtonElement>("button", { name: "Connect" }).click();
      await waitForSolid(() => expect(originalRequest).toHaveBeenCalledOnce());
      view.getByRole<HTMLButtonElement>("button", { name: "Close" }).click();
      await waitForSolid(() =>
        expect(view.container.querySelector("openclaw-modal-dialog")).toBeNull(),
      );

      gateway.client = new GatewayBrowserClient({ url: "wss://replacement.example.test" });
      const replacement = createDeferred<DevicePairJoinSetup>();
      const nextRequest = vi
        .spyOn(gateway.client, "request")
        .mockReturnValueOnce(replacement.promise);
      view.getByRole<HTMLButtonElement>("button", { name: "Connect" }).click();
      await waitForSolid(() => expect(nextRequest).toHaveBeenCalledOnce());
      if (outcome === "resolve") {
        retired.resolve(code("retired-secret"));
      } else {
        retired.reject(new Error("Retired failure"));
      }
      replacement.resolve(code("current-secret"));
      await waitForSolid(() =>
        expect(view.getByText(code("current-secret").command)).toBeDefined(),
      );
      expect(view.queryByText(code("retired-secret").command)).toBeNull();
      expect(view.queryByRole("alert")).toBeNull();
      expect(
        view.getByRole<HTMLButtonElement>("button", { name: "Create new code" }).disabled,
      ).toBe(false);
    },
  );
});
