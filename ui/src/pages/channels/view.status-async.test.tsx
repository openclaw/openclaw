/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ChannelsStatusSnapshot } from "../../api/types.ts";
import { projectChannels } from "../../lib/reactive/domain-capabilities.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  channelSnapshot,
  createChannelsViewProps,
  mountChannelSource,
} from "./view.test-support.ts";
import { ChannelsView } from "./view.tsx";

function snapshot(label: string, partial = false): ChannelsStatusSnapshot {
  return channelSnapshot(
    { slack: { configured: true, running: true, connected: true } },
    {
      channelLabels: { slack: label },
      partial,
      warnings: partial ? ["Slack probe unavailable"] : [],
    },
  );
}

function mountHub(reads: ReturnType<typeof createDeferred<ChannelsStatusSnapshot>>[]) {
  return mountChannelSource(reads, "channels.status", "operator.read", (channels) => {
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
}

it("retains status cards, old errors, partial diagnostics and the open detail through refresh", async () => {
  const initialRead = createDeferred<ChannelsStatusSnapshot>();
  const failedRead = createDeferred<ChannelsStatusSnapshot>();
  const recoveredRead = createDeferred<ChannelsStatusSnapshot>();
  const f = mountHub([initialRead, failedRead, recoveredRead]);
  const initial = f.channels.refresh();
  await waitForSolid(() => {
    expect(f.query(".channels-item__detail")).not.toBeNull();
    expect(f.query(".settings-loading-skeleton")).toBeNull();
  });
  initialRead.resolve(snapshot("Slack", true));
  await initial;
  await waitForSolid(() => expect(f.container.textContent).toContain("Slack probe unavailable"));
  const card = Array.from(f.queryAll<HTMLButtonElement>("button.channels-item")).find((button) =>
    button.textContent?.includes("Slack"),
  )!;
  expect(card).toBeDefined();
  card.focus();

  const failed = f.channels.refresh(true);
  await waitForSolid(() => {
    expect(f.query(".callout.info")).not.toBeNull();
    expect(f.container.contains(card)).toBe(true);
    expect(document.activeElement).toBe(card);
  });
  failedRead.reject(new Error("Status transport unavailable"));
  await failed;
  await waitForSolid(() =>
    expect(f.query(".callout.danger")?.textContent).toBe("Status transport unavailable"),
  );
  expect(f.container.contains(card)).toBe(true);
  expect(document.activeElement).toBe(card);

  card.click();
  await waitForSolid(() => expect(f.query("openclaw-modal-dialog")).not.toBeNull());
  const dialog = f.query("openclaw-modal-dialog");
  const recovered = f.channels.refresh();
  await waitForSolid(() => {
    const notices = Array.from(f.queryAll(".callout"));
    expect(notices.slice(0, 3).map((node) => node.className)).toEqual([
      "callout info",
      "callout warn",
      "callout danger",
    ]);
    expect(notices[1]?.textContent).toContain("Slack probe unavailable");
    expect(notices[2]?.textContent).toBe("Status transport unavailable");
    expect(f.query("openclaw-modal-dialog")).toBe(dialog);
  });
  recoveredRead.resolve(snapshot("Slack recovered"));
  await recovered;
  await waitForSolid(() => {
    expect(card.textContent).toContain("Slack recovered");
    expect(f.query(".callout.danger")).toBeNull();
    expect(f.container.textContent).not.toContain("Slack probe unavailable");
  });
  expect(f.container.contains(card)).toBe(true);
  expect(f.query("openclaw-modal-dialog")).toBe(dialog);
});

it("keeps recommended channels available through an initial read failure and retry", async () => {
  const failedRead = createDeferred<ChannelsStatusSnapshot>();
  const recoveredRead = createDeferred<ChannelsStatusSnapshot>();
  const f = mountHub([failedRead, recoveredRead]);
  const failed = f.channels.refresh();
  await waitForSolid(() => expect(f.query(".channels-item__detail")).not.toBeNull());
  const recommended = f.query(".channels-item__detail");
  failedRead.reject(new Error("Initial status unavailable"));
  await failed;
  await waitForSolid(() =>
    expect(f.query(".callout.danger")?.textContent).toBe("Initial status unavailable"),
  );
  const recovered = f.channels.refresh();
  await waitForSolid(() => {
    expect(f.query(".callout.danger")?.textContent).toBe("Initial status unavailable");
    expect(f.query(".callout.info")).toBeNull();
    expect(f.query(".settings-loading-skeleton")).toBeNull();
    expect(f.query(".channels-item__detail")).toBe(recommended);
  });
  recoveredRead.resolve(snapshot("Slack"));
  await recovered;
  await waitForSolid(() => expect(f.query(".callout.danger")).toBeNull());
  expect(f.query(".channels-item__detail")).toBe(recommended);
});
