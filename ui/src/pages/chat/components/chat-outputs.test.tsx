/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import type { ChatDetailsOutputs } from "./chat-details-types.ts";
import { ChatOutputsDesktop, ChatOutputsMobile } from "./chat-outputs.tsx";
import type { SessionWorkspaceArtifacts } from "./chat-session-workspace-types.ts";

it.each([false, true])(
  "retains the focused artifact row through refresh failure and retry (desktop=%s)",
  async (desktop) => {
    const owner: SessionWorkspaceArtifacts = {
      items: [{ id: "report", title: "Report.txt", type: "file", download: { mode: "bytes" } }],
      resolved: true,
      loaded: true,
      loading: false,
      error: null,
    };
    let complete = () => {};
    const retry = vi.fn(() => {
      owner.readResult = new Promise<void>((resolve) => {
        complete = resolve;
      });
      owner.loading = true;
      owner.error = null;
      draw();
    });
    const read = (): ChatDetailsOutputs => ({
      artifacts: owner.items,
      artifactRead: owner,
      artifactsError: owner.error,
      dashboard: null,
      dashboardError: null,
      onOpenArtifact() {},
      onRetryArtifacts: retry,
      onViewAll() {},
      renderArtifactIcon: () => null,
      renderViewAllIcon: () => null,
    });
    const [outputs, setOutputs] = createSignal(read());
    function draw() {
      setOutputs(read());
      flush();
    }
    const view = mountSolid(() =>
      desktop ? <ChatOutputsDesktop {...outputs()} /> : <ChatOutputsMobile {...outputs()} />,
    );
    onTestFinished(view.unmount);
    await waitForSolid(() => expect(view.getByRole("button", { name: "Report.txt" })).toBeTruthy());
    const row = view.getByRole("button", { name: "Report.txt" });
    row.focus();
    retry();
    await waitForSolid(() => expect(view.getByRole("status").textContent).toContain("Updating"));
    owner.loading = false;
    owner.error = "Files refresh failed";
    complete();
    draw();
    await waitForSolid(() =>
      expect(view.getByRole("status").textContent).toContain("Files refresh failed"),
    );
    expect(view.getByRole("button", { name: "Report.txt" })).toBe(row);
    expect(document.activeElement).toBe(row);
    view.getByRole("button", { name: "Retry" }).click();
    await waitForSolid(() => expect(retry).toHaveBeenCalledTimes(2));
    expect(view.getByRole("button", { name: "Report.txt" })).toBe(row);
    expect(document.activeElement).toBe(row);
    owner.loading = false;
    complete();
    draw();
    await waitForSolid(() => expect(view.queryByRole("status")).toBeNull());
    expect(view.getByRole("button", { name: "Report.txt" })).toBe(row);
    expect(document.activeElement).toBe(row);
  },
);
