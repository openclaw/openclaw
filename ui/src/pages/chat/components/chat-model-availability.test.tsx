/* @vitest-environment jsdom */
import { expect, it, onTestFinished, vi } from "vitest";
import type { ModelCatalogEntry } from "../../../api/types.ts";
import { createSessionsListResult } from "../../../test-helpers/chat-model.ts";
import { installModelPickerLayout } from "../../../test-helpers/model-picker-layout.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatModelControls } from "./chat-model-controls.tsx";

it.each([false, true])(
  "projects cooldown and selected-account expiry through the picker (alternate=%s)",
  async (alternate) => {
    installModelPickerLayout();
    const now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    onTestFinished(() => clock.mockRestore());
    const unavailable = {
      available: false,
      unavailableReason: "cooldown",
      unavailableUntil: now + 720_000,
    } as const;
    const model: ModelCatalogEntry = {
      id: "model",
      name: "Model",
      provider: "example",
      available: true,
      agentRuntime: { id: "openclaw", source: "model" },
      ...(alternate
        ? { runtimeChoices: [{ ...unavailable, agentRuntime: { id: "codex", source: "model" } }] }
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
        modelCatalog={[model]}
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
    const row = view.container.querySelector<HTMLButtonElement>(
      '[data-chat-model-option="example/model"]',
    );
    expect(row?.disabled).toBe(true);
    expect(
      view.container.querySelector(".chat-controls__auth-meta openclaw-tooltip"),
    ).toHaveProperty("content", "Credential expires in 3m");
    view.unmount();
  },
);
