import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { stageReplyMedia } from "./stage-reply-media.js";

const staged = vi.hoisted(() => vi.fn(async () => ({ staged: [] })));
// mock-isolation: Crossing this call would stage media into the affected workspace.
vi.mock("./stage-sandbox-media.js", () => ({ stageSandboxMedia: staged }));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("refuses media staging into a saved workspace awaiting repair", async () => {
  const own = tempDirs.make("media-own-");
  const other = tempDirs.make("media-other-");
  fs.writeFileSync(path.join(other, "openclaw-workspace-state.json"), "retained");
  await expect(
    stageReplyMedia({
      ctx: {},
      sessionCtx: {},
      cfg: { agents: { entries: { main: { workspace: own }, other: { workspace: other } } } },
      agentId: "main",
      sessionKey: "agent:main:media-proof",
      workspaceDir: own,
      sessionEntry: { sessionId: "media-proof", updatedAt: 1, spawnedCwd: other },
    }),
  ).rejects.toThrow(/doctor --fix/);
  expect(staged).not.toHaveBeenCalled();
});
