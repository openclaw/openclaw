/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import * as messageNormalizer from "../../../lib/chat/message-normalizer.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { chatStartupStatusLabel } from "../chat-run-startup.ts";
import { resolveMessageGroupSenderLabel } from "./chat-message-sender.ts";
import { StreamGroup, type StreamGroupPart } from "./chat-message-stream-view.tsx";
import { projectChatPositions } from "./chat-position-projection.ts";

function renderStartup(...args: Parameters<typeof chatStartupStatusLabel>) {
  const startupLabel = chatStartupStatusLabel(...args);
  return mountSolid(() => (
    <StreamGroup
      parts={[{ kind: "reading-indicator", key: "reading", startedAt: 1_000 }]}
      options={{ startupLabel }}
    />
  )).container;
}

it("renders the startup status with elapsed time instead of a working phrase", () => {
  const container = renderStartup(
    { state: "status", runId: "startup-run", phase: "waiting_for_state" },
    null,
  );
  expect(container.querySelector(".chat-working-indicator__status")?.textContent).toContain(
    "Temporarily busy—retrying…",
  );
  expect(container.querySelector(".chat-working-indicator__elapsed")).not.toBeNull();
  expect(
    container.querySelector(".chat-working-indicator__status > .sr-only, openclaw-working-phrase"),
  ).toBeNull();
});

it("labels certified contention as a calm system notice", () => {
  const message = {
    customType: "run-failed-before-reply",
    details: { errorKind: "state_contention" },
  };
  expect(resolveMessageGroupSenderLabel({ role: "custom", messages: [{ message }] }, {})).toBe(
    "System",
  );
});

it.each([
  [{ mode: "snapshot" }, "Starting from snapshot…"],
  [{ mode: "cold", reason: "no-snapshot-yet", phase: "preparing" }, "Preparing cloud environment…"],
  [{ mode: "cold", reason: "no-snapshot-yet", phase: "saving" }, "Saving snapshot…"],
  [{ mode: "snapshot", phase: "saving" }, "Saving snapshot…"],
  [{ mode: "cold", reason: "warm-images-off", phase: "provisioning" }, "Provisioning environment…"],
] as const)("renders cloud start status in the existing line (%j)", (startStatus, label) => {
  const provisioning = {
    sessionKey: "agent:main:cloud-status",
    phase: "provisioning",
    startedAt: 1_000,
  } as const;
  const container = renderStartup(null, provisioning, startStatus);
  expect(container.querySelectorAll(".chat-working-indicator__status")).toHaveLength(1);
  expect(container.querySelector(".chat-working-indicator__status")?.textContent).toContain(label);
  expect(container.textContent).not.toMatch(/no-snapshot-yet|warm-images-off/);
  const runStatus = (phase: "provisioning_environment" | "starting_model") =>
    chatStartupStatusLabel({ state: "status", runId: "run", phase }, null, startStatus);
  expect([
    chatStartupStatusLabel(null, { ...provisioning, phase: "reconnecting", startStatus }),
    runStatus("provisioning_environment"),
    runStatus("starting_model"),
  ]).toEqual(["Reconnecting…", label, "Waiting for a response"]);
});

it("retains the bubble and completed markdown while replacing stream snapshots and settling", () => {
  const first: StreamGroupPart = {
    kind: "stream",
    key: "stream:answer",
    startedAt: 1,
    isStreaming: true,
    text: "A completed paragraph.\n\nA growing",
    thinking: "",
  };
  const [parts, setParts] = createSignal<StreamGroupPart[]>([first]);
  const view = mountSolid(() => <StreamGroup parts={parts()} options={{}} />);
  flush();
  const bubble = view.container.querySelector(".chat-bubble");
  const completed = view.container.querySelector(".chat-text p");
  expect(completed?.textContent).toBe("A completed paragraph.");
  for (const [suffix, isStreaming] of [
    [" reply", true],
    [" reply that settled.", false],
  ] as const) {
    setParts([{ ...first, text: first.text + suffix, isStreaming }]);
    flush();
    expect(view.container.querySelector(".chat-bubble")).toBe(bubble);
    expect(view.container.querySelector(".chat-text p")).toBe(completed);
    expect(view.container.querySelector(".chat-text")?.textContent).toContain("A growing" + suffix);
  }
  expect(bubble?.classList.contains("streaming")).toBe(false);
});

it("prepares interleaved stream snapshots once for the rail and bubble", () => {
  const normalize = vi.spyOn(messageNormalizer, "normalizeMessage");
  onTestFinished(() => normalize.mockRestore());
  const first = {
    kind: "stream",
    key: "stream:answer",
    startedAt: 1,
    isStreaming: true,
    text: "<thinking>Hidden</thinking>First answer",
    thinking: "Explicit reasoning",
  } as const;
  const second = { ...first, text: "Second answer" };
  const positions = (part: typeof first | typeof second) =>
    projectChatPositions([{ kind: "stream-run", key: "run", parts: [part] }], new Map(), new Map());
  const railFirst = positions(first);
  const railSecond = positions(second);
  const [parts, setParts] = createSignal<StreamGroupPart[]>([first]);
  const view = mountSolid(() => <StreamGroup parts={parts()} options={{}} />);
  flush();
  expect(view.container.querySelector(".chat-text p")?.textContent).toBe("First answer");
  setParts([second]);
  flush();
  expect(view.container.querySelector(".chat-text p")?.textContent).toBe("Second answer");
  expect(normalize).toHaveBeenCalledTimes(2);
  expect(positions(first).markers[0]?.message).toBe(railFirst.markers[0]?.message);
  expect(positions(second).markers[0]?.message).toBe(railSecond.markers[0]?.message);
});
