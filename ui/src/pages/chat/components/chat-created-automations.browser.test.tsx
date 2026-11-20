import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished } from "vitest";
import type { AutomationCreationRow } from "../../../lib/chat/automation-creation-card.ts";
import { createCronJob } from "../../../test-helpers/cron.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { mountPlan } from "./chat-created-automations.test-support.tsx";
import "../../../styles.css";
import "../../../styles/chat.ts";
import "../../../styles/settings-native-controls.css";

it.each([
  [1, 280],
  [3, 280],
  [1, 780],
  [3, 780],
] as const)("keeps %i slots fixed in a %ipx assistant message column", async (count, width) => {
  const job = createCronJob("digest", "Very long automation name for a very narrow reading column");
  const rows: AutomationCreationRow[] = [
    "Morning PR digest",
    "Weekly issue recap",
    "Monthly changelog",
  ]
    .slice(0, count)
    .map((name, i) => ({ slotId: String(i), jobId: job.id + i, name }));
  const read = Promise.withResolvers<void>();
  const card = mountPlan(rows, async (_method, params) => {
    await read.promise;
    return { ...job, id: asOptionalRecord(params)?.id };
  });
  onTestFinished(card.unmount);
  const group = document.createElement("div");
  group.className = "chat-group assistant";
  group.style.width = width + "px";
  const column = document.createElement("div");
  column.className = "chat-group-messages";
  group.append(column);
  document.body.append(group);
  column.append(card.container);
  card.container.className = "chat-bubble";
  onTestFinished(() => group.remove());
  const bounds = () =>
    [
      card.getByRole("group"),
      ...card.getAllByRole("listitem"),
      ...card.container.querySelectorAll(".chat-created-automations__action"),
    ].map((node) => node.getBoundingClientRect().toJSON());
  const before = bounds();
  expect(before[1].height).toBe(56);
  expect(card.getAllByText("Created", { exact: true })).toHaveLength(count);
  expect(card.queryByRole("switch")).toBeNull();

  read.resolve();
  await waitForSolid(() => expect(card.getAllByRole("switch")).toHaveLength(count));
  expect(bounds()).toEqual(before);
});
