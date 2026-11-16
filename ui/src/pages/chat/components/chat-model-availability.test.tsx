/* @vitest-environment jsdom */
import { expect, it, onTestFinished, vi } from "vitest";
import type { ModelCatalogEntry } from "../../../api/types.ts";
import { createSessionsListResult } from "../../../test-helpers/chat-model.ts";
import { installModelPickerLayout } from "../../../test-helpers/model-picker-layout.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatModelControls } from "./chat-model-controls.tsx";

it.each([
  { alternate: false, pinned: false, all: true },
  { alternate: true, pinned: false, all: false },
  { alternate: false, pinned: true, all: false },
  { alternate: true, pinned: true, all: true },
])(
  "shows inert cooldowns without expiry or context controls (alternate=$alternate, pinned=$pinned, all=$all)",
  async ({ alternate, pinned, all }) => {
    installModelPickerLayout();
    const now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    onTestFinished(() => clock.mockRestore());
    const unavailable = {
      available: false,
      unavailableReason: "cooldown",
      unavailableUntil: now + 720_000,
    } as const;
    const contextWindows = [
      { id: "400k", label: "400K", contextWindow: 400_000 },
      { id: "1m", label: "1M", contextWindow: 1_000_000 },
    ];
    const model: ModelCatalogEntry = {
      id: "model",
      name: "Model",
      provider: "example",
      available: true,
      contextWindow: 400_000,
      agentRuntime: { id: "openclaw", source: "model" },
      ...(alternate
        ? {
            runtimeChoices: [
              { ...unavailable, contextWindows, agentRuntime: { id: "codex", source: "model" } },
            ],
          }
        : unavailable),
    };
    const sessions = createSessionsListResult({
      model: "model",
      modelProvider: "example",
      defaultsModel: "model",
      defaultsProvider: "example",
    });
    sessions.sessions[0]!.agentRuntime = {
      id: alternate ? "codex" : "openclaw",
      source: alternate ? "session-key" : "model",
    };
    sessions.sessions[0]!.contextWindows = contextWindows;
    sessions.sessions[0]!.contextWindow = "400k";
    sessions.sessions[0]!.modelOverrideSource = pinned ? "user" : undefined;
    const onSelect = vi.fn();
    const view = mountSolid(() => (
      <ChatModelControls
        activeRunId={null}
        connected
        gatewayAvailable
        loading={false}
        modelSwitching={false}
        sending={false}
        stream={null}
        modelPickerOpen
        modelCatalog={[
          model,
          {
            id: "other",
            name: "Other model",
            provider: "example",
            contextWindow: 400_000,
            ...(all ? unavailable : { available: true }),
          },
        ]}
        onModelSelect={onSelect}
        modelCatalogState={{ hasSnapshot: true, status: "ready" }}
        sessionKey="main"
        selectedSession={sessions.sessions[0]}
        sessionsResult={sessions}
        accountSelection={{
          kind: "personal",
          label: "Personal",
          authProfileId: "example:personal",
          source: "user",
        }}
        modelAuthStatusResult={{
          ts: now,
          providers: [
            {
              provider: "example",
              displayName: "Example",
              status: "expiring",
              expiry: { at: now + 720_000, remainingMs: 720_000, label: "12m" },
              profiles: [
                {
                  profileId: "example:personal",
                  type: "oauth",
                  status: "expiring",
                  displayName: "Personal",
                  email: "you@example.com",
                  expiry: { at: now + 180_000, remainingMs: 180_000, label: "3m" },
                },
              ],
            },
          ],
        }}
      />
    ));
    await waitForSolid(() =>
      expect(view.container.querySelector(".chat-controls__model-cooldown")?.textContent).toBe(
        "Cooldown 12m",
      ),
    );
    const row = view.container.querySelector<HTMLElement>(
      '[data-chat-model-option="example/model"]',
    );
    expect(row?.getAttribute("aria-disabled")).toBe("true");
    expect(row?.getAttribute("aria-label")).toContain("Cooling down");
    expect(view.container.querySelector(".chat-controls__context-trigger")).toBeNull();
    const header = view.container.querySelector(".chat-controls__provider-heading");
    expect(header?.querySelectorAll(".chat-controls__model-cooldown")).toHaveLength(all ? 1 : 0);
    expect(row?.querySelector(".chat-controls__model-option-meta")?.textContent ?? "").toBe(
      all ? "" : "Cooldown 12m",
    );
    expect(header?.querySelector("openclaw-tooltip")).toBeNull();
    expect(header?.textContent).not.toMatch(/expires|3m/);
    const other = view.container.querySelector<HTMLElement>(
      '[data-chat-model-option="example/other"]',
    );
    expect(other?.getAttribute("aria-disabled") === "true").toBe(all);
    expect(other?.querySelector(".chat-controls__model-option-meta")?.textContent ?? "").toBe(
      all ? "" : "400k",
    );
    row?.click();
    expect(onSelect).not.toHaveBeenCalled();
    view.unmount();
  },
);
