/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import { chatStartupStatusLabel } from "../chat-run-startup.ts";
import { resolveMessageGroupSenderLabel } from "./chat-message-group.ts";
import { renderStreamGroup } from "./chat-message.ts";

describe("chat message startup status", () => {
  it.each([
    ["preparing_workspace", "Preparing workspace…"],
    ["provisioning_environment", "Provisioning environment…"],
    ["preparing_context", "Preparing this turn…"],
    ["memory_flushing", "Saving conversation memory…"],
    ["starting_model", "Waiting for a response…"],
    ["waiting_for_state", "Temporarily busy—retrying…"],
  ] as const)("renders the %s startup phase with elapsed time", (startupPhase, label) => {
    const container = document.createElement("div");

    render(
      renderStreamGroup([{ kind: "reading-indicator", key: "reading", startedAt: 1_000 }], {
        startupLabel: chatStartupStatusLabel(
          { state: "status", runId: "startup-run", phase: startupPhase },
          null,
        ),
      }),
      container,
    );

    expect(container.querySelector(".chat-working-indicator__status")?.textContent).toContain(
      label,
    );
    expect(container.querySelector(".chat-working-indicator__elapsed")).not.toBeNull();
    expect(container.querySelector(".chat-working-indicator__status > .sr-only")).toBeNull();
    expect(container.querySelector("openclaw-working-phrase")).toBeNull();
  });
});

it.each([undefined, "unknown", "state_contention"])(
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
