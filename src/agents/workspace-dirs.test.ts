import { describe, expect, it } from "vitest";
import { listAgentWorkspaceDirs } from "./workspace-dirs.js";

describe("listAgentWorkspaceDirs", () => {
  it("enumerates an ownerless multi-agent roster without inventing a default", () => {
    expect(
      listAgentWorkspaceDirs({
        agents: {
          entries: {
            ops: { workspace: "/tmp/openclaw-ops" },
            research: { workspace: "/tmp/openclaw-research" },
          },
        },
      }),
    ).toEqual(["/tmp/openclaw-ops", "/tmp/openclaw-research"]);
  });
});
