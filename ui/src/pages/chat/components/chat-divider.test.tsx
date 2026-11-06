import { expect, it } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { projectChatSystemNotice } from "../chat-system-notice.ts";
import { ChatNotice } from "./chat-notice-view.tsx";

it.each(["queued", "cancelled", "history"] as const)(
  "keeps restart recovery out of %s notices",
  (stage) => {
    const timestamp = 1000;
    const message = {
      role: "user",
      content: "The Gateway restarted while you were working. Resume your work.",
      timestamp,
      provenance: { kind: "internal_system", sourceTool: "restart" },
    };
    const items = projectChatSystemNotice(
      { kind: "message", key: "restart", message },
      undefined,
      stage !== "history" ? { status: stage, key: "pending:restart", timestamp } : undefined,
    );
    expect(items).toEqual([]);
  },
);

it("retains actionable update outcomes rather than collapsing them", () => {
  const text =
    "Update failed. Run openclaw doctor to inspect the installation before trying again.";
  const [item] = projectChatSystemNotice({
    kind: "message",
    key: "sentinel",
    message: {
      role: "user",
      content: text,
      provenance: { kind: "internal_system", sourceTool: "restart-sentinel" },
    },
  });
  if (item?.kind !== "notice") {
    throw new Error("Expected update outcome");
  }
  const view = mountSolid(() => <ChatNotice item={item} />);
  expect(view.container.textContent).toContain(text);
  expect(view.container.querySelector("details")).toBeNull();
});
