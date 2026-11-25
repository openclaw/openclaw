/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import * as confirmDialog from "../../components/confirm-dialog.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { createActiveSessionPlacement } from "../../test-helpers/session-placement.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  createContext,
  createGateway,
  createManagedSessions,
  createRenderedPage,
  openRowMenu,
  sessionRow,
} from "./sessions-page.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("sessions page cloud stop", () => {
  it.each(["active", "provisioning"] as const)(
    "stops a %s cloud worker while adopting roster updates",
    async (state) => {
      const stopped = createDeferred<{ ok: true }>();
      const request = vi.fn(() => stopped.promise);
      const managed = createManagedSessions();
      const context = createContext(
        createGateway({ request } as unknown as GatewayBrowserClient).gateway,
        managed.sessions,
      );
      const placement = createActiveSessionPlacement({ environmentId: "environment-1" });
      const target = sessionRow("cloud", {
        label: "Cloud task",
        hasActiveRun: state === "provisioning",
        placement: state === "active" ? placement : { ...placement, state },
      });
      const page = await createRenderedPage(context, sessionsResult([target], 1));
      expect((await openRowMenu(page, target)).textContent).toContain(
        state === "active" ? "Stop cloud device…" : "Stop session on device…",
      );
      const [query] = managed.subscribeList.mock.calls[0]!;
      managed.refreshList.mockClear();
      const showConfirmDialog = vi
        .spyOn(confirmDialog, "showConfirmDialog")
        .mockResolvedValue(true);
      const stopping = page.stopCloudWorker(target);
      await waitForFast(() => expect(request).toHaveBeenCalledOnce());
      expect(showConfirmDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          title:
            state === "active" ? "Stop this cloud device?" : "Stop “Cloud task” on its device?",
          message:
            state === "active"
              ? "The session stops working on it and the cloud device is released. Your conversation and accepted changes stay."
              : "This session stops working on its device after saving workspace changes. Your conversation and saved changes stay.",
          details: `Session: ${target.label ?? target.key}`,
          confirmLabel: "Stop",
        }),
      );
      managed.publish(query, {
        result: sessionsResult([{ ...target, label: "Updated while stopping" }], 2),
        agentId: "main",
        loading: false,
        error: null,
      });
      expect(page.result?.sessions[0]?.label).toBe("Updated while stopping");
      stopped.resolve({ ok: true });
      await stopping;
      expect(showConfirmDialog).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledWith(
        "sessions.reclaim",
        { key: target.key, agentId: "main" },
        { timeoutMs: null },
      );
      expect(managed.refreshList).toHaveBeenCalledWith({ ...query, force: true });
      expect(page.result?.sessions[0]?.label).toBe("Updated while stopping");
    },
  );
});
