import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSkillsWorkspace } from "./skills-cli-gateway.js";

const config = vi.hoisted(() => ({ current: {} as OpenClawConfig }));
vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  captureRuntimeConfigAsyncReader: () => async () => config.current,
}));

const fleet = (systemAgent?: string): OpenClawConfig => ({
  agents: {
    ownership: "explicit",
    ...(systemAgent ? { defaults: { systemAgent: { agentId: systemAgent } } } : {}),
    entries: { alpha: { workspace: "/tmp/skills-alpha" }, ops: { workspace: "/tmp/skills-ops" } },
  },
});

describe("resolveSkillsWorkspace", () => {
  it("uses the configured system agent when an explicit fleet omits --agent", async () => {
    config.current = fleet("ops");
    await expect(resolveSkillsWorkspace()).resolves.toMatchObject({
      agentId: "ops",
      workspaceDir: "/tmp/skills-ops",
    });
    config.current = fleet();
    await expect(resolveSkillsWorkspace()).rejects.toThrow("Pass --agent <id>.");
  });
});
