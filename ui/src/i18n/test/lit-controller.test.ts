import type { ReactiveControllerHost } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nController } from "../lib/lit-controller.ts";
import { i18n } from "../lib/translate.ts";
import type { Locale } from "../lib/types.ts";

describe("I18nController", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requests an initial update when the host connects", () => {
    const addController = vi.fn();
    const requestUpdate = vi.fn();
    const unsubscribe = vi.fn();
    const subscribeSpy = vi.spyOn(i18n, "subscribe").mockReturnValue(unsubscribe);

    const host: ReactiveControllerHost = {
      addController,
      removeController() {},
      requestUpdate,
      updateComplete: Promise.resolve(true),
    };

    const controller = new I18nController(host);
    expect(addController).toHaveBeenCalledWith(controller);
    controller.hostConnected();

    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    expect(requestUpdate).toHaveBeenCalledTimes(1);
  });

  it("requests update on locale changes and unsubscribes when disconnected", () => {
    const addController = vi.fn();
    const requestUpdate = vi.fn();
    const unsubscribe = vi.fn();
    let subscriber: ((locale: Locale) => void) | undefined;
    const subscribeSpy = vi.spyOn(i18n, "subscribe").mockImplementation((next) => {
      subscriber = next as (locale: Locale) => void;
      return unsubscribe;
    });

    const host: ReactiveControllerHost = {
      addController,
      removeController() {},
      requestUpdate,
      updateComplete: Promise.resolve(true),
    };

    const controller = new I18nController(host);
    expect(addController).toHaveBeenCalledWith(controller);
    controller.hostConnected();

    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    expect(requestUpdate).toHaveBeenCalledTimes(1);

    if (!subscriber) {
      throw new Error("expected locale subscriber to be registered");
    }
    subscriber("zh-CN");
    expect(requestUpdate).toHaveBeenCalledTimes(2);

    controller.hostDisconnected();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
