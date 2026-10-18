/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { chatStartupStatusLabel } from "../chat-run-startup.ts";
import { resolveMessageGroupSenderLabel } from "./chat-message-sender.ts";
import { StreamGroup, type StreamGroupPart } from "./chat-message-stream-view.tsx";

function renderStartup(startupLabel: string | undefined) {
  return mountSolid(() => (
    <StreamGroup
      parts={[{ kind: "reading-indicator", key: "reading", startedAt: 1_000 }]}
      options={{ startupLabel }}
    />
  )).container;
}

it("renders the startup status with elapsed time instead of a working phrase", () => {
  const container = renderStartup(
    chatStartupStatusLabel(
      { state: "status", runId: "startup-run", phase: "waiting_for_state" },
      null,
    ),
  );
  expect(container.querySelector(".chat-working-indicator__status")?.textContent).toContain(
    "Temporarily busy—retrying…",
  );
  expect(container.querySelector(".chat-working-indicator__elapsed")).not.toBeNull();
  expect(container.querySelector(".chat-working-indicator__status > .sr-only")).toBeNull();
  expect(container.querySelector("openclaw-working-phrase")).toBeNull();
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
  const container = renderStartup(chatStartupStatusLabel(null, provisioning, startStatus));
  expect(container.querySelectorAll(".chat-working-indicator__status")).toHaveLength(1);
  expect(container.querySelector(".chat-working-indicator__status")?.textContent).toContain(label);
  expect(container.textContent).not.toContain("no-snapshot-yet");
  expect(container.textContent).not.toContain("warm-images-off");
  const runStatus = (phase: "provisioning_environment" | "starting_model") =>
    chatStartupStatusLabel({ state: "status", runId: "run", phase }, null, startStatus);
  expect([
    chatStartupStatusLabel(null, { ...provisioning, phase: "reconnecting", startStatus }),
    runStatus("provisioning_environment"),
    runStatus("starting_model"),
  ]).toEqual(["Reconnecting…", label, "Waiting for a response"]);
});

describe("native transcript streams", () => {
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
      expect(view.container.querySelector(".chat-text")?.textContent).toContain(
        "A growing" + suffix,
      );
    }
    expect(bubble?.classList.contains("streaming")).toBe(false);
  });
});
