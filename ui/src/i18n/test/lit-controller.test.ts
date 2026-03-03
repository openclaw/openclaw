import type { ReactiveControllerHost } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nController } from "../lib/lit-controller.ts";
import { i18n } from "../lib/translate.ts";

describe("I18nController", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requests an initial update when the host connects", () => {
    let controller: I18nController | null = null;
    const requestUpdate = vi.fn();
    const unsubscribe = vi.fn();
    const subscribeSpy = vi.spyOn(i18n, "subscribe").mockReturnValue(unsubscribe);

    const host: ReactiveControllerHost = {
      addController(next) {
        controller = next as I18nController;
      },
      removeController() {},
      requestUpdate,
    };

    new I18nController(host);
    expect(controller).not.toBeNull();
    controller?.hostConnected();

    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    expect(requestUpdate).toHaveBeenCalledTimes(1);
  });

  it("requests update on locale changes and unsubscribes when disconnected", () => {
    let controller: I18nController | null = null;
    const requestUpdate = vi.fn();
    const unsubscribe = vi.fn();
    let subscriber: ((locale: never) => void) | null = null;
    const subscribeSpy = vi.spyOn(i18n, "subscribe").mockImplementation((next) => {
      subscriber = next as (locale: never) => void;
      return unsubscribe;
    });

    const host: ReactiveControllerHost = {
      addController(next) {
        controller = next as I18nController;
      },
      removeController() {},
      requestUpdate,
    };

    new I18nController(host);
    expect(controller).not.toBeNull();
    controller?.hostConnected();

    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    expect(requestUpdate).toHaveBeenCalledTimes(1);

    subscriber?.("zh-CN" as never);
    expect(requestUpdate).toHaveBeenCalledTimes(2);

    controller?.hostDisconnected();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
