import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { digestClawHubSkillTree } from "../../src/skills/lifecycle/skill-tree-digest.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const execFileAsync = promisify(execFile);
const testNodeExecPath = resolveTestNodeExecPath();
const checkerSource = path.resolve(
  process.env.OPENCLAW_TEST_RELEASE_VALIDATION_CHECKER ??
    ".agents/skills/openclaw-release-validation/scripts/check-update.mjs",
);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const writeJson = (file: string, value: unknown) => writeFile(file, JSON.stringify(value));
const updateCommand = ["openclaw", "skills", "update", "@openclaw/release-validation", "--global"];

function expectNoUpdate(result: Awaited<ReturnType<typeof runChecker>>, status: string) {
  expect(result.status).toBe(status);
  expect(result.update).toBeUndefined();
}

async function runChecker(
  scriptPath: string,
  workspace: string,
  envOverrides: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: workspace },
) {
  const preloadPath = path.join(path.dirname(workspace), "mock-fetch.mjs");
  await writeFile(
    preloadPath,
    `globalThis.fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.searchParams.get("ownerHandle") !== "openclaw") {
        throw new Error("missing owner-qualified ClawHub detail lookup");
      }
      return new Response(JSON.stringify({
        latestVersion: { version: "0.1.7" },
        owner: { handle: "openclaw" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };\n`,
  );
  const { stdout } = await execFileAsync(
    testNodeExecPath,
    ["--import", pathToFileURL(preloadPath).href, scriptPath],
    { env: { ...process.env, ...envOverrides }, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout) as {
    localModifications: boolean;
    status: string;
    update?: { command: string[] };
  };
}

test.each([".clawhub", ".clawdhub"])(
  "%s metadata: updates require a core-valid link and preserve the global target",
  async (metadataDirectory) => {
    const fixture = tempDirs.make("release-validation-update-check-");
    const workspace = path.join(fixture, "workspace");
    const skillDirectory = path.join(workspace, "skills", "release-validation");
    const scriptDirectory = path.join(skillDirectory, "scripts");
    await mkdir(path.join(skillDirectory, "assets"), { recursive: true });
    await mkdir(scriptDirectory);
    await writeFile(path.join(skillDirectory, "SKILL.md"), "# Release validation\n");
    await writeFile(path.join(skillDirectory, "assets", "worksheet.md"), "original\n");
    if (path.sep === "/") {
      await writeFile(path.join(skillDirectory, "literal\\name.txt"), "portable path\n");
    }
    const scriptPath = path.join(scriptDirectory, "check-update.mjs");
    await writeFile(scriptPath, await readFile(checkerSource));
    const check = (env?: NodeJS.ProcessEnv) => runChecker(scriptPath, workspace, env);

    const fileTreeSha256 = await digestClawHubSkillTree(skillDirectory);
    const skillFile = {
      path: "SKILL.md",
      sha256: createHash("sha256").update("# Release validation\n").digest("hex"),
    };
    await mkdir(path.join(skillDirectory, metadataDirectory));
    const originPath = path.join(skillDirectory, metadataDirectory, "origin.json");
    const receipt = { installedAt: 1, ownerHandle: "openclaw", skillFile, fileTreeSha256 };
    const origin = {
      ...receipt,
      version: 1,
      registry: "https://clawhub.ai",
      slug: "release-validation",
      installedVersion: "0.1.6",
    };
    await writeJson(originPath, origin);
    await mkdir(path.join(workspace, metadataDirectory));
    const lockPath = path.join(workspace, metadataDirectory, "lock.json");
    const lockEntry = { ...receipt, version: "0.1.6" };
    const writeLock = (entry: unknown, file = lockPath) =>
      writeJson(file, { version: 1, skills: { "release-validation": entry } });
    await writeLock(lockEntry);

    expect(await check()).toMatchObject({
      localModifications: false,
      status: "update-available",
      update: { command: updateCommand },
    });

    const stateLink = path.join(fixture, "state-link");
    await symlink(workspace, stateLink, process.platform === "win32" ? "junction" : "dir");
    for (const env of [
      { OPENCLAW_STATE_DIR: stateLink },
      {
        OPENCLAW_STATE_DIR: "",
        OPENCLAW_CONFIG_PATH: path.join(workspace, "custom-openclaw.json"),
      },
      { OPENCLAW_HOME: fixture, OPENCLAW_STATE_DIR: "~/workspace" },
    ]) {
      expect((await check(env)).update?.command).toContain("--global");
    }

    await writeFile(path.join(skillDirectory, "assets", "worksheet.md"), "locally edited\n");
    const modified = await check();
    expect(modified).toMatchObject({
      localModifications: true,
      status: "update-available",
      update: { command: [...updateCommand, "--force"] },
    });

    await writeJson(originPath, {
      ...origin,
      registry: " https://clawhub.ai/ ",
      ownerHandle: " OpenClaw ",
    });
    const normalized = await check();
    expect(normalized.status).toBe("update-available");
    expect(normalized.update).toBeDefined();

    const { ownerHandle: _ownerHandle, ...ownerlessOrigin } = origin;
    await writeJson(originPath, ownerlessOrigin);
    expectNoUpdate(await check(), "different-source");

    await writeJson(originPath, origin);
    await writeLock({ ...lockEntry, ownerHandle: "other-owner" });
    expectNoUpdate(await check(), "untracked");

    const { fileTreeSha256: _tree, skillFile: _skillFile, ...legacyLockEntry } = lockEntry;
    await writeLock(legacyLockEntry);
    expectNoUpdate(await check(), "untracked");

    await writeJson(originPath, origin);
    await writeLock(lockEntry);
    const primaryOriginPath = path.join(skillDirectory, ".clawhub", "origin.json");
    await mkdir(path.dirname(primaryOriginPath), { recursive: true });
    await writeFile(primaryOriginPath, "{not json");
    expectNoUpdate(await check(), "check-failed");

    await writeJson(primaryOriginPath, origin);
    const primaryLockPath = path.join(workspace, ".clawhub", "lock.json");
    await mkdir(path.dirname(primaryLockPath), { recursive: true });
    await writeJson(primaryLockPath, { version: 2, skills: {} });
    expectNoUpdate(await check(), "check-failed");

    await writeLock(lockEntry, primaryLockPath);
    await writeFile(path.join(skillDirectory, "assets", "worksheet.md"), "original\n");
    const linkedWorkspace = path.join(fixture, "linked-workspace");
    await mkdir(path.join(linkedWorkspace, "skills"), { recursive: true });
    await symlink(
      skillDirectory,
      path.join(linkedWorkspace, "skills", "release-validation"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await mkdir(path.join(linkedWorkspace, ".clawhub"));
    await writeLock(lockEntry, path.join(linkedWorkspace, ".clawhub", "lock.json"));
    const symlinkedRoot = await runChecker(
      path.join(linkedWorkspace, "skills", "release-validation", "scripts", "check-update.mjs"),
      linkedWorkspace,
    );
    expectNoUpdate(symlinkedRoot, "check-failed");
  },
);
