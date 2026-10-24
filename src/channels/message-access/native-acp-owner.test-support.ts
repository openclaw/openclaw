import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import { resolveConfiguredAcpBindingSpecFromRecord } from "../../acp/persistent-bindings.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveConfiguredBinding } from "../plugins/configured-binding-registry.js";

export function configureNativeAcp(
  cfg: OpenClawConfig,
  state: OpenClawTestState,
  channel: "discord" | "telegram",
  publish = () => {},
) {
  const backendId = channel === "discord" ? "discord-owner-proof" : "telegram-native-owner-proof";
  const route = { channel, accountId: "default" };
  const peer =
    channel === "discord"
      ? { kind: "channel" as const, id: "234567890123456789" }
      : { kind: "group" as const, id: "-10012345:topic:42" };
  cfg.acp = { enabled: true, backend: backendId, allowedAgents: ["main"] };
  cfg.session = { store: state.path("native-acp-sessions.json") };
  cfg.agents = {
    ownership: "explicit",
    defaults: { systemAgent: { agentId: "main" }, thinkingDefault: "high" },
    entries: { main: { workspace: state.workspaceDir, model: "fixture/current" } },
  };
  cfg.bindings = [
    {
      type: "acp",
      agentId: "main",
      match: { ...route, peer },
      acp: { backend: backendId, cwd: state.workspaceDir, mode: "persistent" },
    },
  ];
  publish();
  const binding = resolveConfiguredBinding({
    cfg,
    conversation: {
      ...route,
      conversationId: peer.id,
      ...(channel === "telegram" ? { parentConversationId: "-10012345" } : {}),
    },
  });
  const spec = binding && resolveConfiguredAcpBindingSpecFromRecord(binding.record);
  if (!binding || !spec) {
    throw new Error("Expected configured native-command ACP binding");
  }
  return { backendId, binding, spec };
}

export function createNativeAcpRuntime(
  backendId: string,
  pauseAt: "capability" | "control" | undefined,
  extendedHandle = false,
) {
  const effects: string[] = [];
  const preparing = createDeferredCore();
  const finish = createDeferredCore();
  const acceptedOptions = new Map<string, string>();
  let paused = false;
  const wait = async (phase: typeof pauseAt) => {
    if (paused && pauseAt === phase) {
      preparing.resolve();
      await finish.promise;
    }
  };
  const runtime: AcpRuntime = {
    ownerAwareSessions: 1,
    async ensureSession(input) {
      effects.push("initialize");
      acceptedOptions.clear();
      for (const [key, value] of [
        ["model", input.model],
        ["thinking", input.thinking],
      ] as const) {
        if (value) {
          acceptedOptions.set(key, value);
        }
      }
      return {
        agentId: input.agentId,
        sessionKey: input.sessionKey,
        backend: backendId,
        runtimeSessionName: input.sessionKey,
        ...(extendedHandle
          ? { backendSessionId: `runtime:${input.sessionKey}`, cwd: input.cwd }
          : {}),
      };
    },
    async getCapabilities() {
      await wait("capability");
      return { controls: ["session/set_config_option"] };
    },
    async setConfigOption({ key, value }) {
      effects.push(`configure:${key}`);
      acceptedOptions.set(key, value);
      if (key === "model") {
        await wait("control");
      }
      return {
        configOptions: [...acceptedOptions].map(([id, currentValue]) => ({ id, currentValue })),
      };
    },
    async close() {
      if (extendedHandle) {
        effects.push("close");
      }
    },
    async cancel() {},
    runTurn() {
      throw new Error("Native preparation must not start a provider turn");
    },
  };
  return {
    runtime,
    effects,
    preparing,
    finish,
    pause: () => {
      paused = true;
    },
  };
}
