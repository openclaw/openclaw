import { expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { projectChatSystemNotice } from "../chat-system-notice.ts";
import { ChatNotice } from "./chat-notice-view.tsx";

it("keeps row-specific provider presentation after the lazy notice icon resolves", async () => {
  const view = mountSolid(() => (
    <ChatNotice
      item={{
        kind: "notice",
        key: "model-change",
        timestamp: 1,
        text: "",
        label: "Model changed",
        modelChange: { from: "workstation/first", to: "workstation/second" },
      }}
      modelCatalog={[
        { provider: "workstation", id: "first", name: "First", providerName: "Alpha" },
        { provider: "workstation", id: "second", name: "Second", providerName: "Bravo" },
      ]}
    />
  ));
  const initials = () =>
    [...view.container.querySelectorAll(".chat-divider__model .provider-brand-icon")].map(
      (icon) => icon.textContent,
    );
  expect(initials()).toEqual(["A", "B"]);
  await vi.dynamicImportSettled();
  expect(initials()).toEqual(["A", "B"]);
});

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
