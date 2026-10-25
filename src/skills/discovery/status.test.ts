import { execFileSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { readLocalSkillCardContentSync } from "../lifecycle/clawhub-status.js";
import { getSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { closeSkillsWatchers } from "../runtime/refresh.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { createCanonicalFixtureSkill } from "../test-support/test-helpers.js";
import type { SkillEntry } from "../types.js";
import {
  buildWorkspaceSkillReadiness,
  buildWorkspaceSkillStatus,
  prepareWorkspaceSkillStatus,
} from "./status.js";

type SkillStatus = ReturnType<typeof buildWorkspaceSkillStatus>["skills"][number];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeSkillsWatchers(true);
    cleanup();
  }),
);
const toolInstallers: NonNullable<SkillEntry["metadata"]>["install"] = [
  { id: "brew", kind: "brew", formula: "fixture-tool" },
  { id: "node", kind: "node", package: "fixture-tool" },
];
let workspaceDir: string;
beforeEach(() => {
  workspaceDir = tempDirs.make("openclaw-skill-status-");
});

function reportFor(entries: SkillEntry[]) {
  return buildWorkspaceSkillStatus(workspaceDir, { entries }).skills;
}

async function cardFixture() {
  const skillDir = await fs.realpath(workspaceDir);
  const cardPath = path.join(skillDir, "skill-card.md");
  await fs.writeFile(cardPath, "# Card\n");
  return { skillDir, cardPath, realCardPath: await fs.realpath(cardPath) };
}

function expectInvalidLink(skill: SkillStatus | undefined, reason: string, slug?: string) {
  expect(skill?.clawhub).toMatchObject({
    status: "invalid",
    valid: false,
    reason: expect.stringContaining(reason),
    ...(slug ? { slug } : {}),
  });
}

describe("buildWorkspaceSkillStatus", () => {
  it("refreshes dependency eligibility and installer preference after a binary is installed", async () => {
    const entries = ["first", "second"].map((name) =>
      createEntry(name, {
        baseDir: workspaceDir,
        metadata: { requires: { bins: ["brew"] }, install: toolInstallers },
      }),
    );
    await withEnvAsync({ PATH: workspaceDir, PATHEXT: ".CMD" }, async () => {
      const options = { entries, config: { skills: { install: { preferBrew: true } } } };
      const before = buildWorkspaceSkillStatus(workspaceDir, options);
      expect(buildWorkspaceSkillReadiness(workspaceDir, options)).toEqual({
        workspaceDir,
        eligible: 0,
        missing: 2,
      });
      for (const skill of before.skills) {
        expect(skill).toMatchObject({ eligible: false, missing: { bins: ["brew"] } });
        expect(skill.install.map((option) => option.id)).toEqual(["node"]);
      }
      await fs.writeFile(
        path.join(workspaceDir, process.platform === "win32" ? "brew.CMD" : "brew"),
        "",
        { mode: 0o755 },
      );
      const after = buildWorkspaceSkillStatus(workspaceDir, options);
      expect(buildWorkspaceSkillReadiness(workspaceDir, options)).toEqual({
        workspaceDir,
        eligible: 2,
        missing: 0,
      });
      for (const skill of after.skills) {
        expect(skill).toMatchObject({ eligible: true, missing: { bins: [] } });
        expect(skill.install.map((option) => option.id)).toEqual(["brew"]);
      }
    });
  });

  it("refreshes local binary status after installation, PATH changes, and removal without rediscovery", async () => {
    const binDir = path.join(workspaceDir, "bin");
    await fs.mkdir(binDir);
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "dependency"),
      name: "dependency",
      description: "Requires local tools",
      metadata: JSON.stringify({
        openclaw: {
          requires: { bins: ["fixture-tool"], anyBins: ["fixture-alt", "fixture-other"] },
          install: toolInstallers,
        },
      }),
    });
    await withEnvAsync(
      {
        HOME: workspaceDir,
        USERPROFILE: workspaceDir,
        OPENCLAW_HOME: workspaceDir,
        OPENCLAW_STATE_DIR: path.join(workspaceDir, "state"),
        OPENCLAW_BUNDLED_SKILLS_DIR: path.join(workspaceDir, "bundled-skills"),
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(workspaceDir, "bundled-plugins"),
        PATH: binDir,
        PATHEXT: ".CMD",
      },
      async () => {
        const read = async () => {
          const { report } = await prepareWorkspaceSkillStatus(workspaceDir, {
            config: { plugins: { enabled: false }, skills: { load: { watch: false } } },
          });
          return report.skills.find((skill) => skill.name === "dependency");
        };
        const unavailable = {
          eligible: false,
          missing: { bins: ["fixture-tool"], anyBins: ["fixture-alt", "fixture-other"] },
          install: [{ id: "node" }],
        };
        expect(await read()).toMatchObject(unavailable);
        const version = getSkillsSnapshotVersion(workspaceDir);
        const binaries = ["fixture-tool", "fixture-alt", "brew"].map((name) =>
          path.join(binDir, process.platform === "win32" ? `${name}.CMD` : name),
        );
        await Promise.all(binaries.map((file) => fs.writeFile(file, "", { mode: 0o755 })));
        expect(await read()).toMatchObject({
          eligible: true,
          missing: { bins: [], anyBins: [] },
          install: [{ id: "brew" }],
        });
        await withEnvAsync({ PATH: path.join(workspaceDir, "other-bin") }, async () => {
          expect(await read()).toMatchObject(unavailable);
        });
        await Promise.all(binaries.map((file) => fs.unlink(file)));
        expect(await read()).toMatchObject(unavailable);
        expect(getSkillsSnapshotVersion(workspaceDir)).toBe(version);
      },
    );
  });

  it("does not link ClawHub origin metadata from the wrong install directory", async () => {
    const copiedSkillDir = path.join(workspaceDir, "skills", "copied-agentreceipt");
    await writeClawHubStatusFixture(workspaceDir, copiedSkillDir, "agentreceipt");

    expectInvalidLink(
      reportFor([createEntry("copied-agentreceipt", { baseDir: copiedSkillDir })])[0],
      "expected ClawHub install directory",
      "agentreceipt",
    );
  });

  it("preserves file facts and requested Skill Card content for caller-supplied entries", async () => {
    const skillDir = path.join(workspaceDir, "selected");
    const cardPath = path.join(skillDir, "skill-card.md");
    const content = "# Selected Skill Card\n";
    await fs.mkdir(skillDir);
    await fs.writeFile(cardPath, content);
    const entry = createEntry("selected", { baseDir: skillDir, source: "openclaw-workspace" });
    const result = await prepareWorkspaceSkillStatus(workspaceDir, {
      entries: [entry],
      skillCardKey: "selected",
      managedSkillsDir: path.join(workspaceDir, "managed"),
    });
    const skillCard = { present: true, path: cardPath, sizeBytes: Buffer.byteLength(content) };
    expect(result.report.skills).toEqual([
      expect.objectContaining({ name: "selected", skillCard }),
    ]);
    expect(result.files).toEqual([
      expect.objectContaining({
        name: "selected",
        filePath: entry.skill.filePath,
        skillCard: { ...skillCard, content },
      }),
    ]);
  });

  it.each(process.platform === "win32" ? ["hardlink"] : ["hardlink", "symlink"])(
    "reads hardlinks but rejects escaping symlinks: %s",
    async (link) => {
      const skillDir = path.join(workspaceDir, "skill");
      const targetPath = path.join(workspaceDir, "card-target.md");
      const cardPath = path.join(skillDir, "skill-card.md");
      const content = "# Local Skill Card 🦞\n";
      await fs.mkdir(skillDir);
      await fs.writeFile(targetPath, content);
      await (link === "hardlink" ? fs.link : fs.symlink)(targetPath, cardPath);
      expect(reportFor([createEntry("card", { baseDir: skillDir })])[0]?.skillCard).toEqual(
        link === "hardlink"
          ? { present: true, path: cardPath, sizeBytes: Buffer.byteLength(content) }
          : undefined,
      );
      expect(readLocalSkillCardContentSync(skillDir)).toBe(
        link === "hardlink" ? content : undefined,
      );
    },
  );

  it("bounds a local Skill Card that grows after its descriptor is pinned", async () => {
    const { skillDir, cardPath, realCardPath } = await cardFixture();
    const maxBytes = 256 * 1024;
    const openSync = fsSync.openSync.bind(fsSync);
    const readFileSync = fsSync.readFileSync.bind(fsSync);
    const readSync = fsSync.readSync.bind(fsSync);
    let cardFd: number | undefined;
    let grew = false;
    let bytesRead = 0;
    const growBeforeRead = (descriptor: unknown) => {
      if (descriptor === cardFd && !grew) {
        grew = true;
        fsSync.appendFileSync(cardPath, "a".repeat(maxBytes));
      }
    };
    const openSpy = vi.spyOn(fsSync, "openSync").mockImplementation((target, flags, mode) => {
      const descriptor = openSync(target, flags, mode);
      if (cardFd === undefined && path.resolve(String(target)) === realCardPath) {
        cardFd = descriptor;
      }
      return descriptor;
    });
    const readFileSpy = vi.spyOn(fsSync, "readFileSync").mockImplementation((target, options) => {
      growBeforeRead(target);
      return readFileSync(target, options);
    });
    const readSpy = vi
      .spyOn(fsSync, "readSync")
      .mockImplementation(
        (
          descriptor: number,
          buffer: NodeJS.ArrayBufferView,
          offsetOrOptions: number | fsSync.ReadOptions = {},
          length?: number,
          position?: fsSync.ReadPosition | null,
        ) => {
          growBeforeRead(descriptor);
          const options =
            typeof offsetOrOptions === "number"
              ? { offset: offsetOrOptions, length, position }
              : offsetOrOptions;
          const count = readSync(descriptor, buffer, options);
          if (descriptor === cardFd) {
            bytesRead += count;
          }
          return count;
        },
      );

    try {
      expect(readLocalSkillCardContentSync(skillDir)?.length).toBeUndefined();
      expect(grew).toBe(true);
      expect(bytesRead).toBeGreaterThan(0);
      expect(bytesRead).toBeLessThanOrEqual(maxBytes + 1);
    } finally {
      readSpy.mockRestore();
      readFileSpy.mockRestore();
      openSpy.mockRestore();
    }
  });

  it.runIf(process.platform !== "win32")(
    "rejects a local Skill Card replaced by a FIFO at descriptor open without blocking",
    async () => {
      const { skillDir, realCardPath } = await cardFixture();
      const openSync = fsSync.openSync.bind(fsSync);
      let swapped = false;
      let unsafeOpen = false;
      const openSpy = vi.spyOn(fsSync, "openSync").mockImplementation((target, flags, mode) => {
        if (path.resolve(String(target)) === realCardPath) {
          if (typeof flags !== "number" || (flags & fsSync.constants.O_NONBLOCK) === 0) {
            unsafeOpen = true;
            throw new Error("Refusing a blocking FIFO fixture open");
          }
          fsSync.unlinkSync(realCardPath);
          execFileSync("mkfifo", [realCardPath]);
          swapped = true;
        }
        return openSync(target, flags, mode);
      });

      try {
        expect(readLocalSkillCardContentSync(skillDir)).toBeUndefined();
        expect(unsafeOpen).toBe(false);
        expect(swapped).toBe(true);
      } finally {
        openSpy.mockRestore();
      }
    },
  );

  it("surfaces malformed or mismatched ClawHub linkage without trusting it", async () => {
    const malformedDir = path.join(workspaceDir, "skills", "malformed");

    await fs.mkdir(path.join(malformedDir, ".clawhub"), { recursive: true });
    await fs.writeFile(path.join(malformedDir, ".clawhub", "origin.json"), "{not json", "utf8");

    for (const [name, version] of [
      ["missing-lock", false],
      ["mismatch", "9.9.9"],
    ] as const) {
      await writeClawHubStatusFixture(
        workspaceDir,
        path.join(workspaceDir, "skills", name),
        name,
        version,
      );
    }

    const report = buildWorkspaceSkillStatus(workspaceDir, {
      entries: ["malformed", "missing-lock", "mismatch", "local-only"].map((name) =>
        createEntry(name, { baseDir: path.join(workspaceDir, "skills", name) }),
      ),
    });
    const [malformed, missing, mismatch, local] = report.skills;

    expectInvalidLink(malformed, "Malformed ClawHub origin metadata");
    expectInvalidLink(missing, "not tracked by the workspace ClawHub lockfile");
    expectInvalidLink(mismatch, "does not match the workspace ClawHub lockfile");
    expect(local).toMatchObject({ name: "local-only" });
    expect(local?.clawhub).toBeUndefined();
    expect(local?.skillCard).toBeUndefined();
  });

  it("reports a globally installed skill as invalid when it is absent from the managed lockfile", async () => {
    const managedParentDir = tempDirs.make("openclaw-managed-");
    const managedSkillsDir = path.join(managedParentDir, "skills");
    const skillDir = path.join(managedSkillsDir, "agentreceipt");
    await writeSkill({ dir: skillDir, name: "agentreceipt", description: "Global skill" });
    await writeClawHubStatusFixture(managedParentDir, skillDir, "agentreceipt", false);

    const report = buildWorkspaceSkillStatus(workspaceDir, { managedSkillsDir });
    const skill = report.skills.find((entry) => entry.skillKey === "agentreceipt");

    expectInvalidLink(skill, "not tracked by the managed ClawHub lockfile");
  });

  it.runIf(process.platform !== "win32")(
    "links a discovered managed skill whose install directory is a symlink",
    async () => {
      const managedParentDir = tempDirs.make("openclaw-managed-");
      const externalSkillDir = tempDirs.make("openclaw-skill-target-");
      const managedSkillsDir = path.join(managedParentDir, "skills");
      await fs.mkdir(managedSkillsDir, { recursive: true });
      await writeSkill({
        dir: externalSkillDir,
        name: "linked-skill",
        description: "Symlinked global skill",
      });
      await fs.symlink(externalSkillDir, path.join(managedSkillsDir, "linked-skill"));
      await writeClawHubStatusFixture(managedParentDir, externalSkillDir, "linked-skill");

      const report = buildWorkspaceSkillStatus(workspaceDir, { managedSkillsDir });
      const skill = report.skills.find((entry) => entry.skillKey === "linked-skill");
      expect(skill).toMatchObject({
        source: "openclaw-managed",
        baseDir: await fs.realpath(externalSkillDir),
        clawhub: {
          status: "linked",
          valid: true,
          lockPath: path.join(managedParentDir, ".clawhub", "lock.json"),
        },
      });
    },
  );

  it("does not expose raw config values in config checks", () => {
    const secret = "discord-token-secret-abc"; // pragma: allowlist secret
    const entry = createEntry("discord", {
      metadata: { requires: { config: ["channels.discord.token"] } },
    });

    const report = buildWorkspaceSkillStatus("/tmp/ws", {
      entries: [entry],
      config: { channels: { discord: { token: secret } } },
    });

    expect(JSON.stringify(report)).not.toContain(secret);
    const discord = report.skills.find((skill) => skill.name === "discord");
    const check = discord?.configChecks.find(
      (entryLocal) => entryLocal.path === "channels.discord.token",
    );
    expect(check).toEqual({ path: "channels.discord.token", satisfied: true });
    expect(check && "value" in check).toBe(false);
  });

  it("preserves source, keys, order and distinct visibility reasons in a mixed skill pack", () => {
    const missingBin = "openclaw-test-definitely-missing-skill-bin";
    const env = "OPENCLAW_TEST_MISSING_SKILL_KEY";
    const pkg = "@openclaw/missing-skill-bin";
    const skills = [
      "ready",
      "needs-bin",
      "needs-env",
      "prompt-hidden",
      "slash-hidden",
      "disabled",
      "bundled-blocked",
    ];
    const report = buildWorkspaceSkillStatus(workspaceDir, {
      agentId: "specialist",
      config: {
        agents: { entries: { specialist: { skills } } },
        skills: {
          allowBundled: ["custodian", "bundle"],
          entries: { disabled: { enabled: false } },
          install: { nodeManager: "pnpm" },
        },
      },
      entries: [
        createEntry("ready", {
          source: "openclaw-workspace",
          metadata: { skillKey: "workspace-key" },
          exposure: { includeInRuntimeRegistry: true } as SkillEntry["exposure"],
        }),
        createEntry("needs-bin", {
          metadata: {
            requires: { bins: [missingBin] },
            install: [{ kind: "node", package: pkg, bins: [missingBin] }],
          },
        }),
        createEntry("needs-env", {
          metadata: {
            primaryEnv: env,
            requires: { env: [env] },
          },
        }),
        createEntry("prompt-hidden", {
          invocation: { userInvocable: true, disableModelInvocation: true },
        }),
        createEntry("slash-hidden", {
          invocation: { userInvocable: false, disableModelInvocation: false },
        }),
        createEntry("agent-filtered"),
        createEntry("disabled"),
        createEntry("bundled-blocked", { source: "openclaw-bundled" }),
        createEntry("custodian", { source: "openclaw-custodian" }),
        createEntry("bundle", { source: "openclaw-bundled" }),
      ],
    });

    expect(report).toMatchObject({ agentId: "specialist", agentSkillFilter: skills });
    expect(
      report.skills.map(({ name, eligible, modelVisible, commandVisible }) => [
        name,
        eligible,
        modelVisible,
        commandVisible,
      ]),
    ).toEqual([
      ["ready", true, true, true],
      ["needs-bin", false, false, false],
      ["needs-env", false, false, false],
      ["prompt-hidden", true, false, true],
      ["slash-hidden", true, true, false],
      ["agent-filtered", true, false, false],
      ["disabled", false, false, false],
      ["bundled-blocked", false, false, false],
      ["custodian", true, false, false],
      ["bundle", true, false, false],
    ]);
    const [
      ready,
      needsBin,
      needsEnv,
      ,
      slashHidden,
      agentFiltered,
      disabled,
      bundledBlocked,
      custodian,
      bundle,
    ] = report.skills;
    expect(ready).toMatchObject({
      source: "openclaw-workspace",
      skillKey: "workspace-key",
      bundled: false,
      blockedByAgentFilter: false,
      userInvocable: true,
    });
    for (const skill of [custodian, bundle]) {
      expect(skill).toMatchObject({
        source: `openclaw-${skill?.name === "bundle" ? "bundled" : "custodian"}`,
        skillKey: skill?.name,
        bundled: true,
        blockedByAgentFilter: true,
      });
    }
    expect(needsBin?.missing).toStrictEqual({ ...noMissing, bins: [missingBin] });
    expect(needsBin?.install).toStrictEqual([
      {
        kind: "node",
        id: "node-0",
        label: `Install ${pkg} (pnpm)`,
        bins: [missingBin],
      },
    ]);
    expect(needsEnv?.primaryEnv).toBe(env);
    expect(needsEnv?.missing).toStrictEqual({ ...noMissing, env: [env] });
    expect(slashHidden?.userInvocable).toBe(false);
    expect(agentFiltered?.blockedByAgentFilter).toBe(true);
    expect(disabled?.disabled).toBe(true);
    expect(bundledBlocked?.blockedByAllowlist).toBe(true);
  });
});

const noMissing = { anyBins: [], bins: [], config: [], env: [], os: [] };

function createEntry(
  name: string,
  {
    source = "test",
    baseDir = `/tmp/${name}`,
    ...entry
  }: Pick<SkillEntry, "metadata" | "invocation" | "exposure"> & {
    source?: string;
    baseDir?: string;
  } = {},
): SkillEntry {
  return {
    skill: createCanonicalFixtureSkill({
      name,
      description: `${name} skill`,
      filePath: `${baseDir}/SKILL.md`,
      baseDir,
      source,
    }),
    frontmatter: {},
    ...entry,
  };
}

async function writeClawHubStatusFixture(
  lockDir: string,
  skillDir: string,
  slug: string,
  lockVersion: string | false = "1.2.3",
) {
  const common = { installedAt: 123, registry: "https://clawhub.ai" };
  const writeMetadata = async (dir: string, file: string, data: unknown) => {
    const target = path.join(dir, ".clawhub", file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  };
  await writeMetadata(skillDir, "origin.json", {
    version: 1,
    slug,
    installedVersion: "1.2.3",
    ...common,
  });
  if (lockVersion === false) {
    return;
  }
  await writeMetadata(lockDir, "lock.json", {
    version: 1,
    skills: {
      [slug]: { version: lockVersion, ...common },
    },
  });
}
