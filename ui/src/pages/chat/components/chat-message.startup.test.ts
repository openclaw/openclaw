/* @vitest-environment jsdom */

import { render } from "lit";
import { expect, it } from "vitest";
import { chatStartupStatusLabel } from "../chat-run-startup.ts";
import { resolveMessageGroupSenderLabel } from "./chat-message-sender.ts";
import { renderStreamGroup } from "./chat-message-stream.test-support.ts";

it("renders the startup status with elapsed time instead of a working phrase", () => {
  const container = document.createElement("div");

  render(
    renderStreamGroup([{ kind: "reading-indicator", key: "reading", startedAt: 1_000 }], {
      startupLabel: chatStartupStatusLabel(
        { state: "status", runId: "startup-run", phase: "waiting_for_state" },
        null,
      ),
    }),
    container,
  );

  expect(container.querySelector(".chat-working-indicator__status")?.textContent).toContain(
    "Temporarily busy—retrying…",
  );
  expect(container.querySelector(".chat-working-indicator__elapsed")).not.toBeNull();
  expect(container.querySelector(".chat-working-indicator__status > .sr-only")).toBeNull();
  expect(container.querySelector("openclaw-working-phrase")).toBeNull();
});

it.each(["state_contention"])(
  "labels only certified contention as a calm system notice (%s)",
  (errorKind) => {
    expect(
      resolveMessageGroupSenderLabel(
        {
          role: "custom",
          messages: [
            { message: { customType: "run-failed-before-reply", details: { errorKind } } },
          ],
        },
        {},
      ),
    ).toBe(errorKind === "state_contention" ? "System" : "Error");
  },
);

it.each([
  [{ mode: "snapshot" }, "Starting from snapshot…"],
  [{ mode: "cold", reason: "no-snapshot-yet", phase: "preparing" }, "Preparing cloud environment…"],
  [{ mode: "cold", reason: "no-snapshot-yet", phase: "saving" }, "Saving snapshot…"],
  [{ mode: "snapshot", phase: "saving" }, "Saving snapshot…"],
  [{ mode: "cold", reason: "warm-images-off", phase: "provisioning" }, "Provisioning environment…"],
] as const)("renders cloud start status in the existing line (%j)", (startStatus, label) => {
  const container = document.createElement("div");
  render(
    renderStreamGroup([{ kind: "reading-indicator", key: "reading", startedAt: 1_000 }], {
      startupLabel: chatStartupStatusLabel(
        null,
        {
          sessionKey: "agent:main:cloud-status",
          phase: "provisioning",
          startedAt: 1_000,
        },
        startStatus,
      ),
    }),
    container,
  );
  expect(container.querySelectorAll(".chat-working-indicator__status")).toHaveLength(1);
  expect(container.querySelector(".chat-working-indicator__status")?.textContent).toContain(label);
  expect(container.textContent).not.toContain("no-snapshot-yet");
  expect(container.textContent).not.toContain("warm-images-off");
  expect(
    chatStartupStatusLabel(null, {
      sessionKey: "agent:main:cloud-status",
      phase: "reconnecting",
      startedAt: 1_000,
      startStatus,
    }),
  ).toBe("Reconnecting…");
  expect(
    chatStartupStatusLabel(
      { state: "status", runId: "run", phase: "provisioning_environment" },
      null,
      startStatus,
    ),
  ).toBe(label);
  expect(
    chatStartupStatusLabel(
      { state: "status", runId: "run", phase: "starting_model" },
      null,
      startStatus,
    ),
  ).toBe("Waiting for a response…");
});
