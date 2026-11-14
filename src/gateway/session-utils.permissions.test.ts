import { afterEach, expect, test, vi } from "vitest";
import * as execDefaults from "../agents/exec-defaults.js";
import { registerAgentHarness } from "../agents/harness/registry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { listAgentsForGateway } from "./session-utils-store.js";
import { withAgentPermissionState } from "./session-utils.permissions.test-support.js";

afterEach(() => resetGlobalHookRunner());

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

test("listAgentsForGateway infers Full Access only from available unrestricted Gateway execution", async () => {
  await withAgentPermissionState(async () => {
    const { agents } = await listAgentsForGateway({
      tools: { exec: { mode: "full" } },
      agents: {
        ownership: "explicit",
        defaults: { model: { primary: "fixture/probe-model" } },
        entries: {
          allowed: {},
          fullWithFalse: { tools: { openclaw: { autoApproveChanges: false } } },
          grantedRestricted: { tools: { deny: ["exec"], openclaw: { autoApproveChanges: true } } },
          editDenied: { tools: { deny: ["edit", "write", "apply_patch"] } },
          execDenied: { tools: { deny: ["exec"] } },
          readOnlyTools: { tools: { allow: ["read", "openclaw"] } },
          messaging: { tools: { profile: "messaging" } },
          providerDenied: { tools: { byProvider: { fixture: { deny: ["exec"] } } } },
          providerGuarded: { tools: { byProvider: { fixture: { exec: { mode: "ask" } } } } },
          node: { tools: { exec: { host: "node" } } },
          workspaceOnly: { tools: { fs: { workspaceOnly: true } } },
        },
      },
    });
    expect(
      Object.fromEntries(
        agents.map(({ id, defaultPermissionMode }) => [id, defaultPermissionMode]),
      ),
    ).toEqual({
      allowed: "full",
      fullwithfalse: "full",
      grantedrestricted: undefined,
      editdenied: "full",
      execdenied: undefined,
      readonlytools: undefined,
      messaging: undefined,
      providerdenied: undefined,
      providerguarded: "guarded",
      node: undefined,
      workspaceonly: undefined,
    });

    const deploymentRestricted = await listAgentsForGateway({
      tools: { exec: { mode: "full" }, gatewayPolicy: { allow: ["read", "openclaw"] } },
      agents: { entries: { main: {} } },
    });
    expect(deploymentRestricted.agents[0]).not.toHaveProperty("defaultPermissionMode");
  });
});

test("listAgentsForGateway does not infer native execution authority from Gateway exec settings", async () => {
  const registry = createEmptyPluginRegistry();
  registry.cliBackends.push({
    pluginId: "fixture",
    source: "fixture",
    backend: {
      id: "fixture-cli",
      config: { command: "false", output: "text", input: "arg" },
    },
  });
  await withPluginRuntimeRegistryScope(registry, () =>
    withAgentPermissionState(async () => {
      registerAgentHarness({
        id: "native-fixture",
        label: "Native Fixture",
        autoSelection: { providerIds: ["fixture"] },
        executionEnvironment: "host-only",
        supports: () => ({ supported: true }),
        runAttempt: async () => {
          throw new Error("Projection must not start a native turn");
        },
      });
      const { agents } = await listAgentsForGateway({
        tools: { exec: { mode: "full" } },
        agents: {
          defaults: { model: { primary: "fixture/probe-model" } },
          entries: {
            ...Object.fromEntries(
              ["openclaw", "native-fixture", "auto", "unregistered"].map((id) => [
                id,
                { models: { "fixture/probe-model": { agentRuntime: { id } } } },
              ]),
            ),
            legacycli: { model: { primary: "fixture-cli/probe-model" } },
          },
        },
      });
      expect(
        Object.fromEntries(
          agents.map(({ id, defaultPermissionMode }) => [id, defaultPermissionMode]),
        ),
      ).toEqual({
        auto: undefined,
        legacycli: undefined,
        "native-fixture": undefined,
        openclaw: "full",
        unregistered: undefined,
      });
    }),
  );
});

test("Default Full Access labels account for applicable host execution gates", async () => {
  await withAgentPermissionState(async () => {
    const registry = createEmptyPluginRegistry();
    registry.typedHooks.push({
      pluginId: "fixture",
      source: "test",
      hookName: "before_tool_call",
      matcher: ["read"],
      handler: () => ({ block: true }),
    });
    initializeGlobalHookRunner(registry);
    const cfg = { tools: { exec: { mode: "full" as const } }, agents: { entries: { main: {} } } };
    expect((await listAgentsForGateway(cfg)).agents[0]?.defaultPermissionMode).toBe("full");
    registry.typedHooks[0]!.matcher = ["exec"];
    expect((await listAgentsForGateway(cfg)).agents[0]?.defaultPermissionMode).toBeUndefined();
  });
});
