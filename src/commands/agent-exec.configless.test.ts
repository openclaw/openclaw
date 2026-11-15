import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRunWorkspaceDir } from "../agents/workspace-run.js";
import { buildExecRunConfig, resolveExecBaseConfig } from "./agent-exec-input.js";

describe("agent exec configless workspace ownership", () => {
  it("materializes the auth-env-only workspace owner", async () => {
    const options = { authEnvOnly: true } as const;

    const config = buildExecRunConfig({
      base: await resolveExecBaseConfig(options),
      cwd: "/run/here",
    });

    expect(
      resolveRunWorkspaceDir({
        agentId: "main",
        config,
        workspaceDir: "/run/here",
      }),
    ).toMatchObject({
      agentId: "main",
      workspaceDir: resolve("/run/here"),
    });
  });
});
