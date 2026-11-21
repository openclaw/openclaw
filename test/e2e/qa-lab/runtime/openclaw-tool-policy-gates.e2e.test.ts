import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createOpenClawCodingTools } from "../../../../src/agents/agent-tools.js";
import { createAgentToolsSandboxContext } from "../../../../src/agents/test-helpers/agent-tools-sandbox-context.js";
import { createHostSandboxFsBridge } from "../../../../src/agents/test-helpers/host-sandbox-fs-bridge.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";

type OpenClawCodingToolsOptions = NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>;

function toolNames(
  config: OpenClawConfig,
  options: Pick<OpenClawCodingToolsOptions, "sandbox"> = {},
) {
  return new Set(
    createOpenClawCodingTools({
      config,
      sessionKey: "agent:policy:main",
      agentId: "policy",
      workspaceDir: path.join(os.tmpdir(), "openclaw-tool-policy-workspace"),
      agentDir: path.join(os.tmpdir(), "openclaw-tool-policy-agent"),
      modelProvider: "openai",
      modelId: "gpt-5.4",
      ...options,
    }).map((tool) => tool.name),
  );
}

function expectIncluded(names: Set<string>, included: string[], excluded: string[]): void {
  for (const name of included) {
    expect(names, `expected ${name} to pass the policy layer`).toContain(name);
  }
  for (const name of excluded) {
    expect(names, `expected ${name} to be rejected by the policy layer`).not.toContain(name);
  }
}

test("OpenClaw applies every configured tool policy as a restrictive intersection", () => {
  let config: OpenClawConfig = { tools: { profile: "coding" } };
  expectIncluded(toolNames(config), ["read", "write", "edit", "exec"], ["message"]);
  config = {
    tools: {
      ...config.tools,
      allow: ["group:fs", "exec", "process"],
      deny: ["apply_patch"],
    },
  };
  expectIncluded(
    toolNames(config),
    ["read", "write", "edit", "exec", "process"],
    ["apply_patch", "message"],
  );

  config = {
    tools: {
      ...config.tools,
      byProvider: {
        openai: {
          profile: "coding",
          allow: ["read", "write", "edit", "exec", "process"],
          deny: ["edit"],
        },
      },
    },
  };
  expectIncluded(
    toolNames(config),
    ["read", "write", "exec", "process"],
    ["apply_patch", "edit", "message"],
  );

  config = {
    tools: config.tools,
    agents: {
      entries: {
        policy: {
          tools: {
            allow: ["read", "write", "exec", "process"],
            deny: ["process"],
          },
        },
      },
    },
  };
  expectIncluded(toolNames(config), ["read", "write", "exec"], ["edit", "process", "message"]);

  const sandboxDir = path.join(os.tmpdir(), "openclaw-tool-policy-sandbox");
  const sandbox = createAgentToolsSandboxContext({
    workspaceDir: sandboxDir,
    agentWorkspaceDir: path.join(os.tmpdir(), "openclaw-tool-policy-workspace"),
    workspaceAccess: "rw",
    fsBridge: createHostSandboxFsBridge(sandboxDir),
    tools: { allow: ["read", "write", "exec"], deny: ["write", "exec"] },
  });
  expectIncluded(toolNames(config, { sandbox }), ["read"], ["write", "edit", "exec"]);
});
