/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { GroupedMessage } from "./chat-message-bubble-view.tsx";
import { prepareChatMessageRender } from "./chat-message-markdown-view.tsx";
import {
  createTranscriptMessageElements,
  TranscriptMessageElementsContext,
} from "./chat-transcript-message-elements.ts";

it("keeps conflict roots registered across updates and retires replaced roots", async () => {
  const message = {
    role: "custom",
    customType: "cloud-workspace-conflict",
    content: "Workspace conflict",
    details: {
      paths: ["src/local.ts"],
      stagedResultRef: "refs/openclaw/worker-results/claim-registration",
    },
    timestamp: 1,
  };
  const registry = createTranscriptMessageElements(() => undefined);
  const view = mountSolid<{ message: unknown }>(
    (props: { message: unknown }) => (
      <TranscriptMessageElementsContext value={registry}>
        <GroupedMessage
          preparation={prepareChatMessageRender(props.message)}
          messageKey="custom-message"
          options={{ isStreaming: false, showReasoning: false }}
        />
      </TranscriptMessageElementsContext>
    ),
    { message },
  );

  try {
    const conflictRoot = expectDefined(
      view.container.querySelector(".chat-bubble--workspace-conflict"),
      "workspace conflict root",
    );
    await waitForSolid(() => expect(registry.elements.get("custom-message")).toBe(conflictRoot));

    view.update({
      message: { ...message, details: { ...message.details, paths: ["src/updated.ts"] } },
    });
    await waitForSolid(() => expect(conflictRoot.textContent).toContain("src/updated.ts"));
    expect(view.container.querySelector(".chat-bubble--workspace-conflict")).toBe(conflictRoot);
    expect(registry.elements.get("custom-message")).toBe(conflictRoot);

    view.update({
      message: {
        role: "custom",
        customType: "system-notice",
        content: "Plain status",
        display: true,
        timestamp: 1,
      },
    });
    await waitForSolid(() =>
      expect(view.container.querySelector(".chat-bubble--workspace-conflict")).toBeNull(),
    );
    const replacement = expectDefined(view.container.querySelector(".chat-bubble"), "message root");
    expect(replacement).not.toBe(conflictRoot);
    expect(registry.elements.get("custom-message")).toBe(replacement);

    view.dispose();
    expect(registry.elements.size).toBe(0);
  } finally {
    view.dispose();
  }
});
