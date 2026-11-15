/* @vitest-environment jsdom */

import { Errored } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { ChatComposerContextPanel } from "./components/chat-composer-context-panel.tsx";
import { ChatNotice } from "./components/chat-notice-view.tsx";

// mock-isolation: Reject optional presentation code before the catalog observer can initialize.
vi.mock("../../lib/reactive/provider-presentation.tsx", () => {
  throw new Error("Provider presentation module unavailable");
});

it("keeps quota controls and model notices when optional provider icons cannot load", async () => {
  const view = mountSolid(() => (
    <Errored fallback={<p>Pane retired</p>}>
      <input aria-label="Message" defaultValue="Keep this draft" />
      <ChatComposerContextPanel
        model={null}
        currentGroup={{
          providers: ["openai"],
          displayName: "OpenAI",
          accountEmail: "account@example.test",
          plan: "Plus",
          windows: [],
          budgets: [],
        }}
        hasSubscription
        quotaUnknown={false}
        open
      />
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
    </Errored>
  ));
  const composer = view.container.querySelector("input")!;
  const usage = view.container.querySelector<HTMLAnchorElement>("[data-chat-provider-usage]")!;
  usage.focus();
  await vi.dynamicImportSettled();
  expect(view.container.querySelector("input")).toBe(composer);
  expect(composer.value).toBe("Keep this draft");
  expect(view.container.querySelector("[data-chat-provider-usage]")).toBe(usage);
  expect(document.activeElement).toBe(usage);
  expect(view.container.querySelector("[data-provider-icon=codex]")).not.toBeNull();
  expect(
    [...view.container.querySelectorAll(".chat-divider__model .provider-brand-icon")].map(
      (icon) => icon.textContent,
    ),
  ).toEqual(["A", "B"]);
  expect(view.container.textContent).not.toContain("Pane retired");
});
