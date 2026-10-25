/* @vitest-environment jsdom */

import { Loading } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { ActivityGroup } from "./chat-message-group-view.tsx";
import { createMessageGroup, createToolResultMessage } from "./chat-message.test-support.ts";
import { nativeRows } from "./chat-transcript-rows.ts";

afterEach(cleanupSolid);

it("includes cached activity and failure content in the first row commit", () => {
  const group = createMessageGroup(
    createToolResultMessage("read-fixture", "read", "Synthetic tool result", {
      timestamp: 1,
      details: { approvalReviewOutcome: "approved" },
      activity: [
        {
          itemId: "tool:read-fixture",
          toolCallId: "read-fixture",
          kind: "tool",
          phase: "end",
          status: "completed",
          title: "Read fixture",
        },
      ],
    }),
    "tool",
  );
  const Notice = nativeRows.notice;
  const view = mountSolid(() => (
    <Loading>
      <ActivityGroup
        groups={[group]}
        options={{ showReasoning: false }}
        presentation="standalone"
      />
      <Notice
        item={{
          kind: "notice",
          key: "failed-run",
          timestamp: 2,
          text: "Synthetic run failure",
          runError: { runId: "failed-run", summary: "Synthetic run failure" },
        }}
      />
    </Loading>
  ));
  flush();
  expect(view.container.querySelector(".chat-activity-group")).not.toBeNull();
  expect(view.container.querySelector('[data-outcome="approved"]')).not.toBeNull();
  expect(view.container.querySelector("openclaw-chat-run-failure-notice")).not.toBeNull();
});
