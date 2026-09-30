import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isConfiguredCommandOwner } from "../auto-reply/command-auth.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createCronScriptRuntime } from "./trigger-script.js";

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;

beforeEach(async () => {
  state = await createOpenClawTestState({
    prefix: "openclaw-heartbeat-exec-",
    env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
  });
});

afterEach(async () => {
  await state.cleanup();
});

const requester = { channel: "telegram", accountId: "default", senderId: "owner-1" };

// Production collector, code-mode runner, and exec tool; only the owner config changes.
describe("heartbeat context collection final command effect", () => {
  it.each([
    ["loses owner status before collection", 0, [false, false]],
    ["loses owner status after the first command", 1, [true, false]],
    ["stays an owner", Number.POSITIVE_INFINITY, [true, true]],
  ])("runs commands only while the chat creator %s", async (_, revokeAfter, expected) => {
    const markers = [state.path("first.marker"), state.path("second.marker")];
    const config: OpenClawConfig = {
      agents: { defaults: { workspace: state.workspaceDir } },
      tools: { exec: { security: "full", ask: "off" } },
      commands: { ownerAllowFrom: ["telegram:owner-1"] },
    };
    const isCurrent = () => {
      if (markers.filter((marker) => fs.existsSync(marker)).length >= revokeAfter) {
        config.commands = { ownerAllowFrom: ["telegram:someone-else"] };
      }
      return isConfiguredCommandOwner(config, requester);
    };
    const result = await createCronScriptRuntime({
      config,
      loadPluginRegistry: createEmptyPluginRegistry,
    }).collectHeartbeatContext({
      agentId: "main",
      monitorJobId: "heartbeat-main",
      sessionKey: "agent:main:main",
      commands: markers.map((marker) => `printf ok > ${JSON.stringify(marker)}`),
      authority: {
        toolsAllow: ["exec"],
        scheduledToolPolicy: { version: 1, mode: "trusted" },
      },
      abortSignal: new AbortController().signal,
      isCurrent,
    });
    expect(result.kind).toBe(expected.every(Boolean) ? "collected" : "error");
    expect(markers.map((marker) => fs.existsSync(marker))).toEqual(expected);
  });
});
