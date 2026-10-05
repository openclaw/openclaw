import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createSyntheticSourceInfo } from "../../agents/sessions/source-info.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { transferSkillResources } from "./skill-resource-transfer.js";

const temps = useAutoCleanupTempDirTracker(afterEach);

it("closes deferred delivery before a held checkout can dispatch or expose resource bytes", async () => {
  const baseDir = await fs.realpath(temps.make("held-skill-source-"));
  const filePath = path.join(baseDir, "SKILL.md");
  await fs.writeFile(filePath, "# Synthetic skill\nRead data.txt.\n");
  await fs.writeFile(path.join(baseDir, "data.txt"), "verified resource");
  const snapshot: SkillSnapshot = {
    prompt: "Synthetic skill",
    skills: [{ name: "held-skill" }],
    resolvedSkills: [
      {
        name: "held-skill",
        description: "Synthetic skill",
        filePath,
        baseDir,
        source: "test",
        sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }),
        disableModelInvocation: false,
        fileHost: "gateway",
      },
    ],
  };
  const blocked = createDeferred();
  const commands: string[] = [];
  const resources = await transferSkillResources({
    snapshot,
    remoteWorkspaceDir: "/held-worker/repo",
    assertCurrent: () => {},
    deferDelivery: () => "all",
    tunnel: {
      runWorkspaceCommand: async (command) => {
        commands.push(JSON.parse(command.input!).op);
        await racePromiseWithAbortSignal(blocked.promise, command.signal!);
        throw new Error("Cancelled discovery must not dispatch");
      },
    },
  });
  expect(resources).toBeDefined();
  const reading = resources!.skillResources.readInstructions(
    resources!.snapshot.resolvedSkills![0]!.filePath,
    {},
  );
  const rejected = expect(reading).rejects.toMatchObject({ name: "AbortError" });
  await resources!.cleanup();
  await rejected;
  expect(commands).toEqual(["discover"]);
  expect(resources!.assertCurrent).toThrow();
  await expect(resources!.resourceReadiness!.wait(new AbortController().signal)).rejects.toThrow();
  blocked.resolve();
  expect(commands).toEqual(["discover"]);
});
