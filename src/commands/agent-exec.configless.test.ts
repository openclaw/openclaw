import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRunWorkspaceDir } from "../agents/workspace-run.js";
import { buildExecRunConfig, resolveExecBaseConfig } from "./agent-exec-input.js";

describe("agent exec configless workspace ownership", () => {
  it.each([{ authEnvOnly: true }, { isolated: true }])(
    "materializes the configless workspace owner for %j",
    async (options) => {
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
    },
  );
});
