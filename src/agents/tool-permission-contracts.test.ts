import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __testing,
  assertActorCanSendMessage,
  assertPermissionContractsReadyForActor,
  resolveActorWebBridgeRoute,
} from "./tool-permission-contracts.js";

describe("tool permission contracts", () => {
  let workspaceDir: string;
  const originalPinchtabEnvDir = process.env.OPENCLAW_PINCHTAB_ENV_DIR;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "openclaw-tool-permissions-"));
    __testing.clearContractsCache();
  });

  afterEach(() => {
    if (workspaceDir) {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
    __testing.clearContractsCache();
    if (originalPinchtabEnvDir === undefined) {
      delete process.env.OPENCLAW_PINCHTAB_ENV_DIR;
    } else {
      process.env.OPENCLAW_PINCHTAB_ENV_DIR = originalPinchtabEnvDir;
    }
  });

  it("fails fast for malformed executive contracts", () => {
    const coreDir = join(workspaceDir, "01_agent_os/core");
    mkdirSync(coreDir, { recursive: true });
    writeFileSync(join(coreDir, "tool_permissions.yaml"), "executive_orchestrator: [", "utf8");
    expect(() =>
      assertPermissionContractsReadyForActor({
        agentId: "main",
        sessionKey: "agent:main:main",
        workspaceDir,
      }),
    ).toThrow("tool permission contracts invalid");
  });

  it("blocks send when subagent forbids send_message", () => {
    const behaviorDir = join(workspaceDir, "01_agent_os/behavior");
    mkdirSync(behaviorDir, { recursive: true });
    writeFileSync(
      join(behaviorDir, "subagents_registry.yaml"),
      `version: 1
subagents:
  - subagent_id: catering_pipeline_builder
    allowed_tools: [web_browsing, file_read, file_write]
    forbidden_tools: [send_message]
    write_scopes: [queue/catering_pipeline_builder/]
    max_pages: 2
`,
      "utf8",
    );
    expect(() =>
      assertActorCanSendMessage({
        agentId: "catering_pipeline_builder",
        sessionKey: "agent:catering_pipeline_builder:subagent:test",
        workspaceDir,
      }),
    ).toThrow("forbidden by actor policy");
  });

  it("resolves actor web bridge route and token from per-instance env file", () => {
    const coreDir = join(workspaceDir, "01_agent_os/core");
    const envDir = join(workspaceDir, "bridge-env");
    mkdirSync(coreDir, { recursive: true });
    mkdirSync(envDir, { recursive: true });
    writeFileSync(
      join(coreDir, "tool_permissions.yaml"),
      `version: 1
executive_orchestrator:
  allowed_tools: [web_browsing]
  forbidden_tools: []
  write_scopes: [executive/]
  max_pages: 30
  web_bridge_provider: pinchtab
  web_bridge_instance: don_cordazzo
  web_bridge_port: 9867
`,
      "utf8",
    );
    writeFileSync(join(envDir, "don_cordazzo.env"), "BRIDGE_TOKEN=test-token-123\n", "utf8");
    process.env.OPENCLAW_PINCHTAB_ENV_DIR = envDir;
    const route = resolveActorWebBridgeRoute({
      agentId: "main",
      sessionKey: "agent:main:main",
      workspaceDir,
    });
    expect(route).toEqual({
      actor: "executive_orchestrator",
      provider: "pinchtab",
      instance: "don_cordazzo",
      port: 9867,
      baseUrl: "http://127.0.0.1:9867",
      token: "test-token-123",
    });
  });
});
