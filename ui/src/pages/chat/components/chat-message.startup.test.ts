/* @vitest-environment jsdom */

import { render } from "lit";
import { expect, it } from "vitest";
import { chatStartupStatusLabel } from "../chat-run-startup.ts";
import { resolveMessageGroupSenderLabel } from "./chat-message-sender.ts";
import { renderStreamGroup } from "./chat-message-stream.ts";

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
