import { expect, it } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { projectChatSystemNotice } from "../chat-system-notice.ts";
import { ChatNotice } from "./chat-notice-view.tsx";

it.each(["queued", "history"] as const)("shows the recorded restart-resume time in %s", (stage) => {
  const timestamp = new Date(2026, 9, 16, 14, 37).getTime();
  const message = {
    role: "user",
    content: "The Gateway restarted while you were working. Resume your work.",
    timestamp,
    provenance: { kind: "internal_system", sourceTool: "restart" },
  };
  const [item] = projectChatSystemNotice(
    { kind: "message", key: "restart", message },
    undefined,
    stage === "queued" ? { status: "queued", key: "pending:restart", timestamp } : undefined,
  );
  if (item?.kind !== "notice") {
    throw new Error("Expected a restart notice");
  }
  const view = mountSolid(() => <ChatNotice item={item} />);
  expect(view.container.querySelector(".chat-divider__metric")?.textContent).toBe("2:37 PM");
  expect(view.container.querySelector(".chat-notice")?.getAttribute("data-ts")).toBe(
    String(timestamp),
  );
});
