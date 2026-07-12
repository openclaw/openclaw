import { describe, expect, it, vi } from "vitest";
import { createWorkspaceWidgetBus } from "./bus.ts";

describe("workspace widget bus", () => {
  it("delivers only to other subscribers on the publisher's tab and channel", () => {
    const bus = createWorkspaceWidgetBus();
    const publisher = bus.connect("tab-a");
    const sameTab = bus.connect("tab-a");
    const otherTab = bus.connect("tab-b");
    const publisherDelivery = vi.fn();
    const sameTabDelivery = vi.fn();
    const otherTabDelivery = vi.fn();

    publisher.subscribe("selection", publisherDelivery);
    sameTab.subscribe("selection", sameTabDelivery);
    otherTab.subscribe("selection", otherTabDelivery);

    expect(publisher.publish("selection", { region: "eu" })).toBe(1);
    expect(publisherDelivery).not.toHaveBeenCalled();
    expect(sameTabDelivery).toHaveBeenCalledWith("selection", { region: "eu" });
    expect(otherTabDelivery).not.toHaveBeenCalled();
  });

  it("revokes every connection belonging to a removed tab", () => {
    const bus = createWorkspaceWidgetBus();
    const removedPublisher = bus.connect("removed");
    const removedSubscriber = bus.connect("removed");
    const keptPublisher = bus.connect("kept");
    const keptSubscriber = bus.connect("kept");
    const removedDelivery = vi.fn();
    const keptDelivery = vi.fn();

    removedSubscriber.subscribe("updates", removedDelivery);
    keptSubscriber.subscribe("updates", keptDelivery);
    bus.retainTabs(new Set(["kept"]));

    expect(removedPublisher.publish("updates", 1)).toBe(0);
    removedSubscriber.subscribe("updates", removedDelivery);
    expect(removedPublisher.publish("updates", 2)).toBe(0);
    expect(removedDelivery).not.toHaveBeenCalled();
    expect(keptPublisher.publish("updates", 3)).toBe(1);
    expect(keptDelivery).toHaveBeenCalledWith("updates", 3);
  });

  it("revokes all connections when the workspace lifecycle is disposed", () => {
    const bus = createWorkspaceWidgetBus();
    const publisher = bus.connect("main");
    const subscriber = bus.connect("main");
    const delivery = vi.fn();
    subscriber.subscribe("updates", delivery);

    bus.dispose();

    expect(publisher.publish("updates", 1)).toBe(0);
    subscriber.subscribe("updates", delivery);
    expect(publisher.publish("updates", 2)).toBe(0);
    expect(delivery).not.toHaveBeenCalled();
  });

  it("disconnecting a widget removes all of its subscriptions", () => {
    const bus = createWorkspaceWidgetBus();
    const publisher = bus.connect("main");
    const subscriber = bus.connect("main");
    const delivery = vi.fn();
    subscriber.subscribe("a", delivery);
    subscriber.subscribe("b", delivery);

    subscriber.dispose();

    expect(publisher.publish("a", 1)).toBe(0);
    expect(publisher.publish("b", 2)).toBe(0);
    expect(delivery).not.toHaveBeenCalled();
  });
});
