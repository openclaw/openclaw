import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createSkillsWatcherMock,
  useSkillsWatcherFixture,
} from "./refresh.watcher.test-support.js";

const observer = createSkillsWatcherMock();
vi.mock("@openclaw/fs-safe/watch", () => ({ watch: observer.watchMock }));
vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
  resolvePluginSkillRootsFromMetadata: () => [],
}));
const fixture = useSkillsWatcherFixture(observer, { expectedShutdownFailure: true });
const refresh = await import("./refresh.js");

it("keeps Claw removal partial across retries after a physical watcher close failure", async () => {
  const workspaceDir = fixture.workspaceDir;
  refresh.ensureSkillsWatcher({ workspaceDir, agentId: "worker" });
  await observer.readyAll();
  const watcher = observer.forRoot(path.join(workspaceDir, "skills"));
  const close = createDeferred();
  watcher.holdClose(close.promise);
  refresh.ensureSkillsWatcher({
    workspaceDir,
    agentId: "worker",
    config: { skills: { load: { watch: false } } },
  });
  await watcher.closeStarted;

  const drain = refresh.closeSkillsWatchersForAgent({ agentId: "worker" });
  const failure = expect(drain).rejects.toThrow(/restart the Gateway, preview removal, and retry/);
  close.reject(new Error("synthetic Windows EPERM"));
  await failure;
  await expect(refresh.closeSkillsWatchersForAgent({ agentId: "worker" })).rejects.toThrow(
    /restart the Gateway, preview removal, and retry/,
  );
  expect(watcher.close).toHaveBeenCalledOnce();
});
