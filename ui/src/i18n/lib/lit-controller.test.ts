// @vitest-environment node
import type { ReactiveControllerHost } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nController } from "./lit-controller.ts";
import { i18n } from "./translate.ts";

function createHost() {
  return {
    addController: vi.fn(),
    removeController: vi.fn(),
    requestUpdate: vi.fn(),
    updateComplete: Promise.resolve(true),
  } satisfies ReactiveControllerHost;
}

describe("I18nController", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("replaces stale subscriptions and cleans up idempotently", () => {
    const firstCleanup = vi.fn();
    const secondCleanup = vi.fn();
    const subscribe = vi
      .spyOn(i18n, "subscribe")
      .mockReturnValueOnce(firstCleanup)
      .mockReturnValueOnce(secondCleanup);
    const host = createHost();
    const controller = new I18nController(host);
    expect(host.addController).toHaveBeenCalledExactlyOnceWith(controller);

    controller.hostConnected();
    controller.hostConnected();
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(firstCleanup).toHaveBeenCalledOnce();

    controller.hostDisconnected();
    controller.hostDisconnected();
    expect(secondCleanup).toHaveBeenCalledOnce();
  });

  it("requests updates on connect and locale notifications", () => {
    const cleanup = vi.fn();
    let notify: (() => void) | undefined;
    vi.spyOn(i18n, "subscribe").mockImplementation((subscriber) => {
      notify = () => subscriber("en");
      return cleanup;
    });
    const host = createHost();
    const controller = new I18nController(host);
    expect(host.addController).toHaveBeenCalledExactlyOnceWith(controller);

    controller.hostConnected();
    expect(host.requestUpdate).toHaveBeenCalledOnce();

    notify?.();
    expect(host.requestUpdate).toHaveBeenCalledTimes(2);

    controller.hostDisconnected();
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
