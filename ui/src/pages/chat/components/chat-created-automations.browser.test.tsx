import { expect, it, onTestFinished } from "vitest";
import type { AutomationCreationRow } from "../../../lib/chat/automation-creation-card.ts";
import { createCronJob } from "../../../test-helpers/cron.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { mountPlan } from "./chat-created-automations.test-support.tsx";
import "../../../styles.css";
import "../../../styles/settings-native-controls.css";

it.each([1, 3])("keeps the footprint of all %i slots as their results arrive", async (count) => {
  const first = { slotId: "first", name: "Morning PR digest", status: "pending" } as const;
  const otherNames = ["Weekly issue recap", "Monthly changelog"].slice(0, count - 1);
  const siblings = (status: "pending" | "failed"): AutomationCreationRow[] =>
    otherNames.map((name) => ({ slotId: name, name, status }));
  const job = createCronJob("digest", "Very long automation name for a very narrow reading column");
  const card = mountPlan([first, ...siblings("pending")], () => job);
  onTestFinished(card.unmount);
  card.container.style.width = "280px";
  const bounds = () =>
    [card.getByRole("group"), ...card.getAllByRole("listitem")].map((node) =>
      node.getBoundingClientRect().toJSON(),
    );
  const before = bounds();
  expect(before[1].height).toBe(56);
  const skeleton = card.container.querySelector<HTMLElement>(
    ".chat-created-automations__switch-placeholder",
  )!;
  const pendingTrack = skeleton.getBoundingClientRect();
  expect(pendingTrack.width).toBe(28);
  expect(pendingTrack.height).toBe(16);
  expect(getComputedStyle(skeleton).borderRadius).not.toBe("0px");
  expect(skeleton.getAnimations()).toHaveLength(0);

  const created = { ...first, status: "created", jobId: job.id } as const;
  card.setPlan({ planId: "plan", rows: [created, ...siblings("pending")] });
  await waitForSolid(() => expect(card.getByRole("switch")).toBeDefined());
  expect(bounds()).toEqual(before);
  const track = card.container.querySelector<HTMLElement>(".settings-toggle__control")!;
  expect(track.getBoundingClientRect().toJSON()).toEqual(pendingTrack.toJSON());
  if (count > 1) {
    card.setPlan({ planId: "plan", rows: [created, ...siblings("failed")] });
    flush();
    const [label] = card.getAllByText("Not created");
    const triangle = card.getAllByRole("listitem")[1]!.querySelector("svg")!;
    expect(getComputedStyle(triangle).color).toBe(getComputedStyle(label!).color);
    expect(getComputedStyle(triangle).fill).toBe("none");
    expect(bounds()).toEqual(before);
  }
});
