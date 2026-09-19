import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { serveWorkspaceSkills } from "./workspace-worker.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);

function fixture() {
  const home = temporary.make("skills-worker-");
  return { home, workspace: path.join(home, "workspace") };
}

it("rejects a discovery request for another workspace before scanning it", async () => {
  const f = fixture();
  const input = Readable.from([
    JSON.stringify({ sourcePlan: { workspaceDir: path.join(f.home, "other") } }),
  ]);
  await expect(
    serveWorkspaceSkills({ ...f, operation: "discovery", input, output: new PassThrough() }),
  ).rejects.toThrow("does not match the provisioned workspace");
});

it("does not treat unknown operations as discovery", async () => {
  const f = fixture();
  await expect(
    serveWorkspaceSkills({
      ...f,
      operation: "unknown",
      input: Readable.from(["{}"]),
      output: new PassThrough(),
    }),
  ).rejects.toThrow("Unknown skill worker operation");
});
