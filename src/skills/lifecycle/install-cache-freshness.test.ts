import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommandWithTimeout } from "../../process/exec.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareWorkspaceSkills } from "../loading/workspace-skill-loader.js";
import { createFixtureSkillEntry } from "../test-support/test-helpers.js";
import { installSkill } from "./install.js";

// mock-isolation: use only fixture recipes without loading host skill discovery or caches.
vi.mock("../loading/workspace-skill-loader.js", () => ({ prepareWorkspaceSkills: vi.fn() }));
// mock-isolation: emulate bootstrap and recipe commands without spawning package installers.
vi.mock("../../process/exec.js", () => ({ runCommandWithTimeout: vi.fn() }));

vi.mock("../../plugins/install-security-scan.js", () => ({
  evaluateSkillInstallPolicy: vi.fn(async () => undefined),
}));

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe.each(["uv", "go"] as const)("%s bootstrap cache freshness", (kind) => {
  it.each([0, 1])("reuses the prerequisite after the first recipe exits %i", async (firstCode) => {
    await withOpenClawTestState({ label: "bootstrap" }, async ({ home, workspaceDir }) => {
      vi.spyOn(os, "homedir").mockReturnValue(home);
      const binDir = path.join(home, ".local", "bin");
      await fs.mkdir(binDir, { recursive: true });
      const writeExecutable = async (name: string) => {
        await fs.writeFile(path.join(binDir, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      };
      await writeExecutable("brew");

      const entries = ["first", "second"].map((name) => {
        const spec =
          kind === "uv"
            ? { kind, package: `fixture-${name}` }
            : { kind, module: `example.com/fixture-${name}@latest` };
        return Object.assign(createFixtureSkillEntry(name), {
          metadata: { install: [{ id: "deps", ...spec }] },
        });
      });
      vi.mocked(prepareWorkspaceSkills).mockResolvedValue(entries);

      let [bootstraps, recipes] = [0, 0];
      await withEnvAsync({ PATH: binDir }, async () => {
        vi.mocked(runCommandWithTimeout).mockImplementation(async (argv, options) => {
          let code = 0;
          let stdout = "";
          let stderr = "";
          if (argv[0] === "brew" && argv[1] === "install" && argv[2] === kind) {
            bootstraps += 1;
            await writeExecutable(kind);
          } else if (argv[0] === "brew" && argv[1] === "--prefix") {
            stdout = path.dirname(binDir);
          } else {
            const name = recipes === 0 ? "first" : "second";
            expect(argv).toEqual(
              kind === "uv"
                ? ["uv", "tool", "install", `fixture-${name}`]
                : ["go", "install", `example.com/fixture-${name}@latest`],
            );
            await fs.access(path.join(binDir, kind), fs.constants.X_OK);
            if (kind === "go") {
              expect(options).toMatchObject({ env: { PATH: binDir, GOBIN: binDir } });
            }
            code = recipes++ === 0 ? firstCode : 0;
            stdout = `recipe ${name}`;
            stderr = code === 0 ? "" : "fixture recipe failed";
          }
          return { code, stdout, stderr, signal: null, killed: false, termination: "exit" };
        });

        for (const [index, skillName] of ["first", "second"].entries()) {
          const code = index === 0 ? firstCode : 0;
          const result = await installSkill({ workspaceDir, skillName, installId: "deps" });
          expect(result).toMatchObject({ ok: code === 0, ...recipeResult(skillName, code) });
          expect(process.env.PATH).toBe(binDir);
        }
        expect({ recipes, bootstraps }).toEqual({ recipes: 2, bootstraps: 1 });
      });
    });
  });
});

function recipeResult(name: string, code: number) {
  return { code, stdout: `recipe ${name}`, stderr: code === 0 ? "" : "fixture recipe failed" };
}
