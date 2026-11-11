import { expect, test, vi } from "vitest";
import * as execDefaults from "../agents/exec-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listAgentsForGateway } from "./session-utils-store.js";
import { withAgentPermissionState } from "./session-utils.permissions.test-support.js";

test("listAgentsForGateway resolves only representable permission labels across sandbox callers", async () => {
  await withAgentPermissionState(async () => {
    for (const mode of ["all", "off", "non-main", "all"] as const) {
      using resolve = vi.spyOn(execDefaults, "resolveExecDefaults");
      const cfg: OpenClawConfig = {
        tools: { exec: { mode: "ask" } },
        agents: {
          defaults: { sandbox: { mode } },
          entries: {
            guarded: {},
            restricted: { tools: { exec: { mode: "allowlist" } } },
            workspace: { sandbox: { mode: "off" }, tools: { exec: { mode: "auto" } } },
          },
        },
      };
      const { agents } = await listAgentsForGateway(cfg);
      expect(agents.map(({ id, defaultPermissionMode }) => [id, defaultPermissionMode])).toEqual([
        ["guarded", mode === "off" ? "guarded" : undefined],
        ["restricted", undefined],
        ["workspace", "workspace"],
      ]);
      expect(resolve).toHaveBeenCalledTimes(mode === "off" ? 3 : 1);
    }
  });
});

test("listAgentsForGateway distinguishes attended creation from existing-session defaults", async () => {
  await withAgentPermissionState(async () => {
    const { agents } = await listAgentsForGateway({
      tools: { exec: { mode: "deny" } },
      agents: { entries: { main: { newSessionPermissionMode: "full" }, unconfigured: {} } },
    });
    expect(agents).toEqual([
      expect.objectContaining({
        id: "main",
        defaultPermissionMode: "read-only",
        newSessionPermissionMode: "full",
      }),
      expect.objectContaining({ id: "unconfigured", defaultPermissionMode: "read-only" }),
    ]);
    expect(agents[1]).not.toHaveProperty("newSessionPermissionMode");
  });
});
