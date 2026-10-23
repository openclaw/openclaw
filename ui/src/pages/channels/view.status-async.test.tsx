/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ChannelsStatusSnapshot } from "../../api/types.ts";
import { createChannelCapability } from "../../lib/channels/index.ts";
import { projectChannels } from "../../lib/reactive/domain-capabilities.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createChannelsViewProps } from "./view.test-support.ts";
import { ChannelsView } from "./view.tsx";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  document.body.replaceChildren();
});

function snapshot(label: string, partial = false): ChannelsStatusSnapshot {
  return {
    ts: 1,
    channelOrder: ["slack"],
    channelLabels: { slack: label },
    channels: { slack: { configured: true, running: true, connected: true } },
    channelAccounts: {},
    channelDefaultAccountId: {},
    partial,
    warnings: partial ? ["Slack probe unavailable"] : [],
  };
}

function mountHub(request: (method: string) => unknown) {
  const client = createTestGatewayClient(request);
  const fixture = createApplicationGateway();
  fixture.publish({
    ...fixture.gateway.snapshot,
    client,
    phase: "connected",
    hello: gatewayHelloForMethods(["channels.status"], ["operator.read"]),
  });
  const channels = createChannelCapability(fixture.gateway);
  const mounted = mountSolid(() => {
    const source = projectChannels(channels);
    const [selected, setSelected] = createSignal<string | null>(null);
    const props = createChannelsViewProps(null, null);
    return (
      <ChannelsView
        {...props}
        channels={source.read()}
        selectedChannel={selected()}
        onShowDetail={(channel) => setSelected(channel)}
        onCloseDetail={() => setSelected(null)}
        onRefresh={(probe) => void channels.refresh(probe)}
      />
    );
  });
  cleanups.push(() => {
    mounted.unmount();
    channels.dispose();
  });
  return { channels, container: mounted.container };
}

it("retains status cards, old errors, partial diagnostics and the open detail through refresh", async () => {
  const initialRead = createDeferred<ChannelsStatusSnapshot>();
  const failedRead = createDeferred<ChannelsStatusSnapshot>();
  const recoveredRead = createDeferred<ChannelsStatusSnapshot>();
  const request = vi
    .fn()
    .mockReturnValueOnce(initialRead.promise)
    .mockReturnValueOnce(failedRead.promise)
    .mockReturnValueOnce(recoveredRead.promise);
  const f = mountHub(request);
  const initial = f.channels.refresh();
  await waitForSolid(() => {
    expect(f.container.querySelector(".channels-item__detail")).not.toBeNull();
    expect(f.container.querySelector(".settings-loading-skeleton")).toBeNull();
  });
  initialRead.resolve(snapshot("Slack", true));
  await initial;
  await waitForSolid(() => expect(f.container.textContent).toContain("Slack probe unavailable"));
  const card = Array.from(
    f.container.querySelectorAll<HTMLButtonElement>("button.channels-item"),
  ).find((button) => button.textContent?.includes("Slack"))!;
  expect(card).toBeDefined();
  card.focus();

  const failed = f.channels.refresh(true);
  await waitForSolid(() => {
    expect(f.container.querySelector(".callout.info")).not.toBeNull();
    expect(f.container.contains(card)).toBe(true);
    expect(document.activeElement).toBe(card);
  });
  failedRead.reject(new Error("Status transport unavailable"));
  await failed;
  await waitForSolid(() =>
    expect(f.container.querySelector(".callout.danger")?.textContent).toBe(
      "Status transport unavailable",
    ),
  );
  expect(f.container.contains(card)).toBe(true);
  expect(document.activeElement).toBe(card);

  card.click();
  await waitForSolid(() =>
    expect(f.container.querySelector("openclaw-modal-dialog")).not.toBeNull(),
  );
  const dialog = f.container.querySelector("openclaw-modal-dialog");
  const recovered = f.channels.refresh();
  await waitForSolid(() => {
    const notices = Array.from(f.container.querySelectorAll(".callout"));
    expect(notices.slice(0, 3).map((node) => node.className)).toEqual([
      "callout info",
      "callout warn",
      "callout danger",
    ]);
    expect(notices[1]?.textContent).toContain("Slack probe unavailable");
    expect(notices[2]?.textContent).toBe("Status transport unavailable");
    expect(f.container.querySelector("openclaw-modal-dialog")).toBe(dialog);
  });
  recoveredRead.resolve(snapshot("Slack recovered"));
  await recovered;
  await waitForSolid(() => {
    expect(card.textContent).toContain("Slack recovered");
    expect(f.container.querySelector(".callout.danger")).toBeNull();
    expect(f.container.textContent).not.toContain("Slack probe unavailable");
  });
  expect(f.container.contains(card)).toBe(true);
  expect(f.container.querySelector("openclaw-modal-dialog")).toBe(dialog);
  expect(request).toHaveBeenCalledTimes(3);
});

it("keeps recommended channels available through an initial read failure and retry", async () => {
  const failedRead = createDeferred<ChannelsStatusSnapshot>();
  const recoveredRead = createDeferred<ChannelsStatusSnapshot>();
  const request = vi
    .fn()
    .mockReturnValueOnce(failedRead.promise)
    .mockReturnValueOnce(recoveredRead.promise);
  const f = mountHub(request);
  const failed = f.channels.refresh();
  await waitForSolid(() =>
    expect(f.container.querySelector(".channels-item__detail")).not.toBeNull(),
  );
  const recommended = f.container.querySelector(".channels-item__detail");
  failedRead.reject(new Error("Initial status unavailable"));
  await failed;
  await waitForSolid(() =>
    expect(f.container.querySelector(".callout.danger")?.textContent).toBe(
      "Initial status unavailable",
    ),
  );
  const recovered = f.channels.refresh();
  await waitForSolid(() => {
    expect(f.container.querySelector(".callout.danger")?.textContent).toBe(
      "Initial status unavailable",
    );
    expect(f.container.querySelector(".callout.info")).toBeNull();
    expect(f.container.querySelector(".settings-loading-skeleton")).toBeNull();
    expect(f.container.querySelector(".channels-item__detail")).toBe(recommended);
  });
  recoveredRead.resolve(snapshot("Slack"));
  await recovered;
  await waitForSolid(() => expect(f.container.querySelector(".callout.danger")).toBeNull());
  expect(f.container.querySelector(".channels-item__detail")).toBe(recommended);
  expect(request).toHaveBeenCalledTimes(2);
});
