import { execFileSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    const workspaceDir = tempDirs.make("openclaw-skill-status-");
    const entries = ["first", "second"].map((name) =>
      createEntry(name, {
        baseDir: workspaceDir,
        metadata: {
          requires: { bins: ["brew"] },
          install: toolInstallers,
        },
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
        expect(skill.eligible).toBe(false);
        expect(skill.missing.bins).toEqual(["brew"]);
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
        expect(skill.eligible).toBe(true);
        expect(skill.missing.bins).toEqual([]);
        expect(skill.install.map((option) => option.id)).toEqual(["brew"]);
      }
    });
  });

  it("refreshes local binary status after installation, PATH changes, and removal without rediscovery", async () => {
    const workspaceDir = tempDirs.make("openclaw-async-skill-status-");
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
          return requireSkillStatus(skillStatusByName(report.skills), "dependency");
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
    const workspaceDir = tempDirs.make("openclaw-skill-status-");
    const copiedSkillDir = path.join(workspaceDir, "skills", "copied-agentreceipt");
    await writeClawHubStatusFixture(workspaceDir, copiedSkillDir, "agentreceipt");

    const report = buildWorkspaceSkillStatus(workspaceDir, {
      entries: [createEntry("copied-agentreceipt", { baseDir: copiedSkillDir })],
    });

    expectInvalidLink(report.skills[0], "expected ClawHub install directory", "agentreceipt");
  });

  it("preserves file facts and requested Skill Card content for caller-supplied entries", async () => {
    const workspaceDir = tempDirs.make("openclaw-supplied-skill-status-");
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

  it("reads a local Skill Card through a hardlink without changing its reported path", async () => {
    const workspaceDir = tempDirs.make("openclaw-skill-status-");
    const skillDir = path.join(workspaceDir, "skill");
    const targetDir = path.join(workspaceDir, "target");
    const targetCard = path.join(targetDir, "skill-card.md");
    const cardPath = path.join(skillDir, "skill-card.md");
    const content = "# Local Skill Card 🦞\n";
    await fs.mkdir(targetDir);
    await fs.writeFile(targetCard, content);
    await fs.mkdir(skillDir);
    await fs.link(targetCard, cardPath);

    const report = buildWorkspaceSkillStatus(workspaceDir, {
      entries: [createEntry("card", { baseDir: skillDir })],
    });

    expect(report.skills[0]?.skillCard).toEqual({
      present: true,
      path: cardPath,
      sizeBytes: Buffer.byteLength(content),
    });
    expect(readLocalSkillCardContentSync(skillDir)).toBe(content);
  });

  it.runIf(process.platform !== "win32")(
    "does not surface or read Skill Card symlinks outside the skill directory",
    async () => {
      const workspaceDir = tempDirs.make("openclaw-skill-status-");
      const skillDir = path.join(workspaceDir, "skill");
      const targetPath = path.join(workspaceDir, "card-target.md");
      await fs.mkdir(skillDir);
      await fs.writeFile(targetPath, "# Card target\n");
      await fs.symlink(targetPath, path.join(skillDir, "skill-card.md"));

      const report = buildWorkspaceSkillStatus(workspaceDir, {
        entries: [createEntry("card", { baseDir: skillDir })],
      });

      expect(report.skills[0]?.skillCard).toBeUndefined();
      expect(readLocalSkillCardContentSync(skillDir)).toBeUndefined();
    },
  );

  it("bounds a local Skill Card that grows after its descriptor is pinned", async () => {
    const skillDir = await fs.realpath(tempDirs.make("openclaw-skill-status-"));
    const cardPath = path.join(skillDir, "skill-card.md");
    const maxBytes = 256 * 1024;
    await fs.writeFile(cardPath, "# Card\n");
    const realCardPath = await fs.realpath(cardPath);
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
      const skillDir = await fs.realpath(tempDirs.make("openclaw-skill-status-"));
      const cardPath = path.join(skillDir, "skill-card.md");
      await fs.writeFile(cardPath, "# Card\n");
      const realCardPath = await fs.realpath(cardPath);
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
    const workspaceDir = tempDirs.make("openclaw-skill-status-");
    const malformedDir = path.join(workspaceDir, "skills", "malformed");

    await fs.mkdir(path.join(malformedDir, ".clawhub"), { recursive: true });
    await fs.writeFile(path.join(malformedDir, ".clawhub", "origin.json"), "{not json", "utf8");

    await writeClawHubStatusFixture(
      workspaceDir,
      path.join(workspaceDir, "skills", "missing-lock"),
      "missing-lock",
      false,
    );
    await writeClawHubStatusFixture(
      workspaceDir,
      path.join(workspaceDir, "skills", "mismatch"),
      "mismatch",
      "9.9.9",
    );

    const report = buildWorkspaceSkillStatus(workspaceDir, {
      entries: ["malformed", "missing-lock", "mismatch", "local-only"].map((name) =>
        createEntry(name, { baseDir: path.join(workspaceDir, "skills", name) }),
      ),
    });
    const byName = skillStatusByName(report.skills);

    expectInvalidLink(requireSkillStatus(byName, "malformed"), "Malformed ClawHub origin metadata");
    expectInvalidLink(
      requireSkillStatus(byName, "missing-lock"),
      "not tracked by the workspace ClawHub lockfile",
    );
    expectInvalidLink(
      requireSkillStatus(byName, "mismatch"),
      "does not match the workspace ClawHub lockfile",
    );
    expect(requireSkillStatus(byName, "local-only").clawhub).toBeUndefined();
    expect(requireSkillStatus(byName, "local-only").skillCard).toBeUndefined();
  });

  it("reports a globally installed skill as invalid when it is absent from the managed lockfile", async () => {
    const managedParentDir = tempDirs.make("openclaw-managed-");
    const workspaceDir = tempDirs.make("openclaw-skill-status-");
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
      const workspaceDir = tempDirs.make("openclaw-skill-status-");
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
      const externalSkillRealDir = await fs.realpath(externalSkillDir);

      expect(skill).toMatchObject({
        source: "openclaw-managed",
        baseDir: externalSkillRealDir,
      });
      expect(skill?.clawhub).toMatchObject({
        status: "linked",
        valid: true,
        lockPath: path.join(managedParentDir, ".clawhub", "lock.json"),
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

  it("uses default-visible exposure semantics when older entries omit exposure fields", () => {
    const entry: SkillEntry = {
      ...createEntry("legacy-exposure"),
      exposure: {
        includeInRuntimeRegistry: true,
      } as SkillEntry["exposure"],
    };

    const report = buildWorkspaceSkillStatus("/tmp/ws", { entries: [entry] });
    const skill = report.skills[0];
    expect(skill).toMatchObject({
      eligible: true,
      modelVisible: true,
      userInvocable: true,
      commandVisible: true,
    });
  });

  it("preserves source, custom keys, order, and agent exclusion in status", () => {
    const workspaceDir = tempDirs.make("openclaw-skill-status-");
    const report = buildWorkspaceSkillStatus(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      entries: (
        [
          ["workspace", "openclaw-workspace", { skillKey: "workspace-key" }],
          ["custodian", "openclaw-custodian", undefined],
          ["bundle", "openclaw-bundled", undefined],
        ] as const
      ).map(([name, source, metadata]) =>
        createEntry(name, {
          source,
          metadata,
          baseDir: path.join(workspaceDir, name),
        }),
      ),
      agentId: "specialist",
      config: { agents: { entries: { specialist: { skills: ["workspace"] } } } },
    });

    expect(report).toMatchObject({ agentId: "specialist", agentSkillFilter: ["workspace"] });
    expect(
      report.skills.map(
        ({ name, source, skillKey, bundled, blockedByAgentFilter, modelVisible }) => [
          name,
          source,
          skillKey,
          bundled,
          blockedByAgentFilter,
          modelVisible,
        ],
      ),
    ).toEqual([
      ["workspace", "openclaw-workspace", "workspace-key", false, false, true],
      ["custodian", "openclaw-custodian", "custodian", true, true, false],
      ["bundle", "openclaw-bundled", "bundle", true, true, false],
    ]);
  });

  it("classifies a mixed broken skill pack without flattening visibility reasons", () => {
    const missingBin = "openclaw-test-definitely-missing-skill-bin";
    const skills = [
      "ready",
      "needs-bin",
      "needs-env",
      "prompt-hidden",
      "slash-hidden",
      "disabled",
      "bundled-blocked",
    ];
    const report = buildWorkspaceSkillStatus("/tmp/ws", {
      agentId: "specialist",
      config: {
        agents: { entries: { specialist: { skills } } },
        skills: {
          allowBundled: [],
          entries: { disabled: { enabled: false } },
          install: { nodeManager: "pnpm" },
        },
      },
      entries: [
        createEntry("ready"),
        createEntry("needs-bin", {
          metadata: {
            requires: { bins: [missingBin] },
            install: [{ kind: "node", package: "@openclaw/missing-skill-bin", bins: [missingBin] }],
          },
        }),
        createEntry("needs-env", {
          metadata: {
            primaryEnv: "OPENCLAW_TEST_MISSING_SKILL_KEY",
            requires: { env: ["OPENCLAW_TEST_MISSING_SKILL_KEY"] },
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
      ],
    });

    const byName = skillStatusByName(report.skills);
    expect(report.agentSkillFilter).toEqual(skills);
    expectStatusFlags(requireSkillStatus(byName, "ready"), true, true, true);
    const needsBin = requireSkillStatus(byName, "needs-bin");
    expectStatusFlags(needsBin, false, false, false);
    expect(needsBin.missing).toStrictEqual({ ...noMissing, bins: [missingBin] });
    expect(needsBin.install).toStrictEqual([
      {
        kind: "node",
        id: "node-0",
        label: "Install @openclaw/missing-skill-bin (pnpm)",
        bins: [missingBin],
      },
    ]);
    const needsEnv = requireSkillStatus(byName, "needs-env");
    expect(needsEnv.eligible).toBe(false);
    expect(needsEnv.primaryEnv).toBe("OPENCLAW_TEST_MISSING_SKILL_KEY");
    expect(needsEnv.missing).toStrictEqual({
      ...noMissing,
      env: ["OPENCLAW_TEST_MISSING_SKILL_KEY"],
    });
    expectStatusFlags(requireSkillStatus(byName, "prompt-hidden"), true, false, true);
    const slashHidden = requireSkillStatus(byName, "slash-hidden");
    expectStatusFlags(slashHidden, true, true, false);
    expect(slashHidden.userInvocable).toBe(false);
    const agentFiltered = requireSkillStatus(byName, "agent-filtered");
    expectStatusFlags(agentFiltered, true, false, false);
    expect(agentFiltered.blockedByAgentFilter).toBe(true);
    const disabled = requireSkillStatus(byName, "disabled");
    expectStatusFlags(disabled, false, false, false);
    expect(disabled.disabled).toBe(true);
    const bundledBlocked = requireSkillStatus(byName, "bundled-blocked");
    expectStatusFlags(bundledBlocked, false, false, false);
    expect(bundledBlocked.blockedByAllowlist).toBe(true);
  });
});

function skillStatusByName(skills: readonly SkillStatus[]): Map<string, SkillStatus> {
  return new Map(skills.map((skill) => [skill.name, skill]));
}

function requireSkillStatus(byName: ReadonlyMap<string, SkillStatus>, name: string): SkillStatus {
  const status = byName.get(name);
  if (!status) {
    throw new Error(`expected skill status ${name}`);
  }
  return status;
}

const noMissing = { anyBins: [], bins: [], config: [], env: [], os: [] };

function expectStatusFlags(
  status: SkillStatus,
  eligible: boolean,
  modelVisible: boolean,
  commandVisible: boolean,
) {
  expect(status).toMatchObject({ eligible, modelVisible, commandVisible });
}

function createEntry(
  name: string,
  params: {
    description?: string;
    source?: string;
    baseDir?: string;
    metadata?: SkillEntry["metadata"];
    invocation?: SkillEntry["invocation"];
  } = {},
): SkillEntry {
  const baseDir = params.baseDir ?? `/tmp/${name}`;
  return {
    skill: createCanonicalFixtureSkill({
      name,
      description: params.description ?? `${name} skill`,
      filePath: `${baseDir}/SKILL.md`,
      baseDir,
      source: params.source ?? "test",
    }),
    frontmatter: {},
    metadata: params.metadata,
    invocation: params.invocation,
  };
}

async function writeClawHubStatusFixture(
  workspaceDir: string,
  skillDir: string,
  slug: string,
  lockVersion: string | false = "1.2.3",
) {
  const installedVersion = "1.2.3";
  const installedAt = 123;
  const registry = "https://clawhub.ai";
  const writeMetadata = async (dir: string, file: string, data: unknown) => {
    const target = path.join(dir, ".clawhub", file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  };
  await writeMetadata(skillDir, "origin.json", {
    version: 1,
    registry,
    slug,
    installedVersion,
    installedAt,
  });
  if (lockVersion === false) {
    return;
  }
  await writeMetadata(workspaceDir, "lock.json", {
    version: 1,
    skills: {
      [slug]: { version: lockVersion, installedAt, registry },
    },
  });
}
