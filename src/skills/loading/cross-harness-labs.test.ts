import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { buildWorkspaceSkillCommandSpecs } from "../discovery/command-specs.js";
import { buildSkillSnapshot } from "./workspace-skill-prompt.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const bundledSkillsDir = fileURLToPath(new URL("../../../skills", import.meta.url));

it("keeps cross-harness labs explicitly invocable and out of the normal model prompt", async () => {
  const workspaceDir = tempDirs.make("openclaw-cross-harness-labs-");
  const options = {
    bundledSkillsDir,
    managedSkillsDir: path.join(workspaceDir, ".managed"),
    config: { skills: { allowBundled: ["cross-harness-labs"] } },
  };

  const commands = buildWorkspaceSkillCommandSpecs(workspaceDir, options);
  expect(commands).toContainEqual(expect.objectContaining({ skillName: "cross-harness-labs" }));
  const snapshot = await buildSkillSnapshot(workspaceDir, options);
  expect(snapshot.skills).toContainEqual(expect.objectContaining({ name: "cross-harness-labs" }));
  expect(snapshot.prompt).not.toContain("cross-harness-labs");
});
