import { describe, expect, it } from "vitest";
import {
  BOUND_FALLBACK_OPERATION_SCOPE_MESSAGE,
  isSystemAgentBoundFallbackOperationAllowed,
} from "./fallback-operation-scope.js";
import type { SystemAgentOperation } from "./operation-types.js";
import { executeSystemAgentOperation } from "./operations-execute.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";

const allowed: SystemAgentOperation[] = [
  { kind: "none", message: "read only" },
  { kind: "overview" },
  { kind: "agents" },
  { kind: "models" },
  { kind: "plugin-list" },
  { kind: "plugin-search", query: "local" },
  { kind: "audit" },
  { kind: "config-validate" },
  { kind: "config-get", path: "gateway.port" },
  { kind: "config-schema" },
  { kind: "channel-list" },
  { kind: "channel-info", channel: "telegram" },
  { kind: "doctor" },
  { kind: "status" },
  { kind: "health" },
  { kind: "gateway-status" },
  { kind: "config-set", path: "env.vars.STAGE", value: "local" },
  { kind: "config-unset", path: "env.vars.STAGE" },
  { kind: "config-set-ref", path: "gateway.auth.token", source: "env", id: "STAGE" },
];

const denied: SystemAgentOperation[] = [
  { kind: "setup" },
  { kind: "plugin-install", spec: "@stage/example" },
  { kind: "plugin-activate-artifact", path: "/stage/archive.tgz", sha256: "0".repeat(64) },
  { kind: "plugin-uninstall", pluginId: "unrelated-plugin" },
  { kind: "create-agent", agentId: "helper" },
  { kind: "create-team", prefix: "stage" },
  { kind: "gateway-start" },
  { kind: "gateway-stop" },
  { kind: "gateway-restart" },
  { kind: "set-default-model", model: "stage/other" },
  { kind: "channel-setup", channel: "telegram" },
  { kind: "skills-setup" },
  { kind: "search-setup" },
  { kind: "gateway-config-setup" },
  { kind: "memory-import" },
  { kind: "model-setup" },
  { kind: "model-accounts" },
  { kind: "open-setup", target: "guided" },
  { kind: "open-tui", agentId: "helper" },
];

describe("bound fallback maintenance scope", () => {
  it.each(allowed)("keeps $kind inside the read/config/SecretRef scope", (operation) => {
    expect(isSystemAgentBoundFallbackOperationAllowed(operation)).toBe(true);
  });

  it.each(denied)("denies $kind before any multi-stage effect", (operation) => {
    expect(isSystemAgentBoundFallbackOperationAllowed(operation)).toBe(false);
  });

  it.each(["create-agent", "plugin-uninstall", "gateway-restart"] as const)(
    "blocks $kind in the executor even without a chat proposal",
    async (kind) => {
      const operation = denied.find((candidate) => candidate.kind === kind)!;
      const { runtime, lines } = createSystemAgentTestRuntime();
      const result = await executeSystemAgentOperation(operation, runtime, {
        approved: false,
        boundFallbackModelRef: "stage/backup",
      });
      expect(result).toMatchObject({
        applied: false,
        message: BOUND_FALLBACK_OPERATION_SCOPE_MESSAGE,
      });
      expect(lines).toContain(BOUND_FALLBACK_OPERATION_SCOPE_MESSAGE);
      expect(lines.join("\n")).not.toContain("[openclaw] running:");
    },
  );

  it("retains the primary route's normal proposal behavior", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();
    const result = await executeSystemAgentOperation(
      { kind: "create-agent", agentId: "helper" },
      runtime,
      { approved: false },
    );
    expect(result.applied).toBe(false);
    expect(lines.join("\n")).toContain("helper");
    expect(lines.join("\n")).not.toContain(BOUND_FALLBACK_OPERATION_SCOPE_MESSAGE);
  });
});
