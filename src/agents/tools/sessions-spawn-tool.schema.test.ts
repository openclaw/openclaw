import "./sessions-spawn-tool.mocks.test-support.js";
import { expect, it } from "vitest";
import { createSessionsSpawnTool } from "./sessions-spawn-tool.js";

it("explains cwd-relative file-tool containment for external workspace edits", () => {
  const tool = createSessionsSpawnTool({ config: {}, agentSessionKey: "agent:main:main" });
  expect(tool.parameters).toMatchObject({
    properties: {
      cwd: {
        description: expect.stringContaining(
          "Workspace-contained file tools (apply_patch/file writes) resolve and contain paths against cwd; set cwd for edits outside the agent workspace.",
        ),
      },
    },
  });
});
