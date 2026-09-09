import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createSessionCapability } from "./index.ts";
import { createGatewayHarness, sessionsResult } from "./session-capability.test-support.ts";

export function defineSessionGroupSelectionTests() {
  it("fences late group reads and writes across A to B to A selection", async () => {
    const oldRead = createDeferred<{ groups: Array<{ name: string; position: number }> }>();
    const oldWrite = createDeferred<{
      ok: boolean;
      groups: Array<{ name: string; position: number }>;
    }>();
    let mainReads = 0;
    const request = vi.fn(async (method: string, params?: { agentId?: string }) => {
      if (method === "sessions.groups.put") {
        return oldWrite.promise;
      }
      if (method === "sessions.groups.list") {
        if (params?.agentId === "main" && ++mainReads === 1) {
          return oldRead.promise;
        }
        return {
          groups: [{ name: params?.agentId === "main" ? "Current A" : "Only B", position: 0 }],
        };
      }
      if (method === "sessions.list") {
        return sessionsResult([], 1);
      }
      return {};
    });
    const { gateway } = createGatewayHarness({ request } as unknown as GatewayBrowserClient, [
      "sessions.groups.list",
      "sessions.groups.put",
    ]);
    let selectedId = "main";
    const listeners = new Set<() => void>();
    const selection = {
      get state() {
        return { selectedId };
      },
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const select = (id: string) => {
      selectedId = id;
      for (const listener of listeners) {
        listener();
      }
    };
    const sessions = createSessionCapability(gateway, selection);
    try {
      const pendingRead = sessions.groupsLoad();
      expect(request).toHaveBeenCalledWith("sessions.groups.list", { agentId: "main" });
      select("research");
      await sessions.groupsLoad();
      expect(sessions.state.groups).toEqual(["Only B"]);
      select("main");
      await sessions.groupsLoad();
      oldRead.resolve({ groups: [{ name: "Stale A", position: 0 }] });
      await pendingRead;
      expect(sessions.state.groups).toEqual(["Current A"]);
      const pendingWrite = sessions.groupsPut(["Old write"]);
      select("research");
      await sessions.groupsLoad();
      select("main");
      await sessions.groupsLoad();
      oldWrite.resolve({ ok: true, groups: [{ name: "Old write", position: 0 }] });
      await expect(pendingWrite).resolves.toBe("stale");
      expect(sessions.state.groups).toEqual(["Current A"]);
      expect(request).toHaveBeenCalledWith("sessions.groups.put", {
        agentId: "main",
        names: ["Old write"],
      });
    } finally {
      sessions.dispose();
    }
  });
}
