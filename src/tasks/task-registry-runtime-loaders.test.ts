import { expect, it } from "vitest";
import { controlRuntimeLoader } from "./task-registry-runtime-loaders.js";

it("loads and invokes real task cancellation from the source module graph", async () => {
  const runtime = await controlRuntimeLoader.load();
  await expect(
    runtime.killSubagentRunAdmin({
      cfg: {},
      sessionKey: "agent:main:subagent:missing-runtime-loader-target",
    }),
  ).resolves.toMatchObject({ found: false, killed: false });
});
