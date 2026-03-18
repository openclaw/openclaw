import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAgentWorkspaceDir } from "../../../agents/agent-scope.js";
import type { CliDeps } from "../../../cli/deps.js";
import type { OpenClawConfig } from "../../../config/config.js";

const runBootOnce = vi.fn();

function createMockLogger() {
  return {
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => createMockLogger()),
  };
}

vi.mock("../../../gateway/boot.js", () => ({ runBootOnce }));
vi.mock("../../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => createMockLogger(),
}));

let runBootChecklist: typeof import("./handler.js").default;
let clearInternalHooks: typeof import("../../internal-hooks.js").clearInternalHooks;
let createInternalHookEvent: typeof import("../../internal-hooks.js").createInternalHookEvent;
let registerInternalHook: typeof import("../../internal-hooks.js").registerInternalHook;
let triggerInternalHook: typeof import("../../internal-hooks.js").triggerInternalHook;

describe("boot-md startup hook integration", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ default: runBootChecklist } = await import("./handler.js"));
    ({ clearInternalHooks, createInternalHookEvent, registerInternalHook, triggerInternalHook } =
      await import("../../internal-hooks.js"));
    runBootOnce.mockClear();
    clearInternalHooks();
  });

  afterEach(() => {
    clearInternalHooks();
  });

  it("dispatches gateway:startup through internal hooks and runs BOOT for each configured agent scope", async () => {
    const cfg = {
      hooks: { internal: { enabled: true } },
      agents: {
        list: [
          { id: "main", default: true, workspace: "/ws/main" },
          { id: "ops", workspace: "/ws/ops" },
        ],
      },
    } as OpenClawConfig;
    const deps = {} as CliDeps;
    runBootOnce.mockResolvedValue({ status: "ran" });

    registerInternalHook("gateway:startup", runBootChecklist);
    const event = createInternalHookEvent("gateway", "startup", "gateway:startup", { cfg, deps });
    await triggerInternalHook(event);

    const mainWorkspaceDir = resolveAgentWorkspaceDir(cfg, "main");
    const opsWorkspaceDir = resolveAgentWorkspaceDir(cfg, "ops");

    expect(runBootOnce).toHaveBeenCalledTimes(2);
    expect(runBootOnce).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ cfg, deps, workspaceDir: mainWorkspaceDir, agentId: "main" }),
    );
    expect(runBootOnce).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cfg, deps, workspaceDir: opsWorkspaceDir, agentId: "ops" }),
    );
  });
});
