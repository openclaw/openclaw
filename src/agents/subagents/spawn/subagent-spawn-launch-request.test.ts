import { describe, expect, it } from "vitest";
import { buildSubagentLaunchRequest } from "./subagent-spawn-launch-request.js";

describe("buildSubagentLaunchRequest", () => {
  it("marks sessions_spawn instructions as internal agent-authored input", () => {
    const result = buildSubagentLaunchRequest({
      completionMode: "announce",
      spawnMode: "run",
      message: "[Subagent Task]\nFix it",
      spawnedByKey: "agent:coordinator:dashboard:parent",
      toolSpawnMetadata: {},
      childSessionKey: "agent:worker:subagent:child",
      childIdem: "idem-1",
      childSystemPrompt: "system",
      runTimeoutSeconds: 60,
      lightContext: false,
      swarmMaxConcurrent: 1,
    });

    expect(result.childLaunch.request.inputProvenance).toEqual({
      kind: "internal_system",
      sourceSessionKey: "agent:coordinator:dashboard:parent",
      sourceTool: "sessions_spawn",
    });
  });
});
