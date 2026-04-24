import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../../src/plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../../src/plugins/hooks.test-helpers.js";
import { createEmptyPluginRegistry } from "../../../src/plugins/registry.js";
import { setActivePluginRegistry } from "../../../src/plugins/runtime.js";

export function textToolResult(
  text: string,
  details: Record<string, unknown> = {},
): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

export function installOpenClawOwnedToolHooks(params?: {
  adjustedParams?: Record<string, unknown>;
  blockReason?: string;
}) {
  const beforeToolCall = vi.fn(async () => {
    if (params?.blockReason) {
      return {
        block: true,
        blockReason: params.blockReason,
      };
    }
    return params?.adjustedParams ? { params: params.adjustedParams } : {};
  });
  const afterToolCall = vi.fn(async () => {});
  initializeGlobalHookRunner(
    createMockPluginRegistry([
      { hookName: "before_tool_call", handler: beforeToolCall },
      { hookName: "after_tool_call", handler: afterToolCall },
    ]),
  );
  return { beforeToolCall, afterToolCall };
}

export function resetOpenClawOwnedToolHooks(): void {
  resetGlobalHookRunner();
  setActivePluginRegistry(createEmptyPluginRegistry());
}
