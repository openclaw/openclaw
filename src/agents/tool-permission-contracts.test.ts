import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __testing,
  assertActorCanSendMessage,
  assertPermissionContractsReadyForActor,
} from "./tool-permission-contracts.js";

describe("tool permission contracts", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "openclaw-tool-permissions-"));
    __testing.clearContractsCache();
  });

  afterEach(() => {
    if (workspaceDir) {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
    __testing.clearContractsCache();
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
});
