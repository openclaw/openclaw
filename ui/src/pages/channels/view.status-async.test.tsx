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

it.each([false, true])(
  "retains channels through failure and retry (cached: %s)",
  async (cached) => {
    const seed = createDeferred<ChannelsStatusSnapshot>();
    const failure = createDeferred<ChannelsStatusSnapshot>();
    const recovery = createDeferred<ChannelsStatusSnapshot>();
    const f = mountHub(cached ? [seed, failure, recovery] : [failure, recovery]);
    let card: HTMLButtonElement | undefined;
    let dialog: HTMLElement | null = null;
    if (cached) {
      const initial = f.channels.refresh();
      seed.resolve(snapshot("Slack", true));
      await initial;
      await waitForSolid(() =>
        expect(f.container.textContent).toContain("Slack probe unavailable"),
      );
      card = Array.from(f.queryAll<HTMLButtonElement>("button.channels-item")).find((button) =>
        button.textContent?.includes("Slack"),
      )!;
      expect(card).toBeDefined();
      card.focus();
    }
    const failed = f.channels.refresh(cached);
    await waitForSolid(() => {
      expect(f.query(".channels-item__detail")).not.toBeNull();
      expect(f.query(".settings-loading-skeleton")).toBeNull();
      if (cached) {
        expect(f.query(".callout.info")).not.toBeNull();
        expect(document.activeElement).toBe(card);
      }
    });
    const recommended = f.query(".channels-item__detail");
    failure.reject(new Error("Status unavailable"));
    await failed;
    await waitForSolid(() =>
      expect(f.query(".callout.danger")?.textContent).toBe("Status unavailable"),
    );
    if (card) {
      expect(document.activeElement).toBe(card);
      card.click();
      await waitForSolid(() => expect(f.query("openclaw-modal-dialog")).not.toBeNull());
      dialog = f.query("openclaw-modal-dialog");
    }
    const recovered = f.channels.refresh();
    await waitForSolid(() => {
      expect(f.query(".callout.danger")?.textContent).toBe("Status unavailable");
      if (cached) {
        expect(Array.from(f.queryAll(".callout"), (node) => node.className).slice(0, 3)).toEqual([
          "callout info",
          "callout warn",
          "callout danger",
        ]);
        expect(f.query(".callout.warn")?.textContent).toContain("Slack probe unavailable");
        expect(f.query("openclaw-modal-dialog")).toBe(dialog);
      } else {
        expect(f.query(".callout.info")).toBeNull();
        expect(f.query(".settings-loading-skeleton")).toBeNull();
        expect(f.query(".channels-item__detail")).toBe(recommended);
      }
    });
    recovery.resolve(snapshot("Slack recovered"));
    await recovered;
    await waitForSolid(() => {
      expect(f.query(".callout.danger")).toBeNull();
      expect(f.container.textContent).not.toContain("Slack probe unavailable");
      if (card) {
        expect(card.textContent).toContain("Slack recovered");
      }
    });
    if (card) {
      expect(f.container.contains(card)).toBe(true);
      expect(f.query("openclaw-modal-dialog")).toBe(dialog);
    } else {
      expect(f.query(".channels-item__detail")).toBe(recommended);
    }
  },
);
