import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import * as factories from "../agents/openclaw-tools.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { resolveSkillDispatchTools } from "../skills/runtime/tool-dispatch.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { resolveMcpLoopbackScopedTools } from "./mcp-http.runtime.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

const dirs = useSessionStoreTempDirs(afterAll, "message-permission-capture-");
afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
  resetPluginRuntimeStateForTest();
});

it.each(["http", "loopback", "skill"] as const)(
  "does not turn route omission into a child or cron denial on %s",
  async (surface) => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {} } },
      session: { store: path.join(dirs.make(), "sessions.json") },
      tools: {
        allow: ["message", "sessions_spawn", "automations"],
        codeMode: false,
        toolSearch: false,
      },
      gateway: { tools: { allow: ["sessions_spawn", "automations"] } },
    };
    setRuntimeConfigSnapshot(cfg);
    setActivePluginRegistry(createTestRegistry());
    const createTools = factories.createOpenClawToolsAsync;
    const spy = vi.spyOn(factories, "createOpenClawToolsAsync").mockImplementation(createTools);
    const sessionKey = "agent:main:route-less-permission";
    const tools =
      surface === "skill"
        ? await resolveSkillDispatchTools({
            message: {},
            cfg,
            agentId: "main",
            sessionKey,
            workspaceDir: dirs.make(),
            provider: "openai",
            model: "synthetic",
            senderIsOwner: true,
          })
        : (surface === "http"
            ? await resolveGatewayScopedTools({ cfg, sessionKey, surface })
            : await resolveMcpLoopbackScopedTools({
                cfg,
                context: { sessionKey, senderIsOwner: true },
              })
          ).tools;
    expect(tools.some((tool) => tool.name === "message")).toBe(false);
    const options = spy.mock.calls.at(-1)?.[0];
    expect(options?.inheritedToolAllowlist).toContain("message");
    expect(options?.cronCreatorToolAllowlist).toContainEqual(
      expect.objectContaining({ name: "message" }),
    );
    if (surface === "loopback") {
      expect(options?.cronCreatorToolAllowlistCaptureRef?.value?.source).toBe(
        "final-executable-surface",
      );
    }
  },
);
