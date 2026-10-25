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

async function cardFixture(content = "# Card\n") {
  const skillDir = await fs.realpath(workspaceDir);
  const cardPath = path.join(skillDir, "skill-card.md");
  await fs.writeFile(cardPath, content);
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
  it("refreshes sync/async status and readiness after install, PATH changes and removal", async () => {
    const binDir = path.join(workspaceDir, "bin");
    await fs.mkdir(binDir);
    for (const name of ["dependency", "second"]) {
      await writeSkill({
        dir: path.join(workspaceDir, "skills", name),
        name,
        description: "Requires local tools",
        metadata: JSON.stringify({
          openclaw: {
            requires: { bins: ["fixture-tool"], anyBins: ["fixture-alt", "fixture-other"] },
            install: toolInstallers,
          },
        }),
      });
    }
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
        const skills = { load: { watch: false }, install: { preferBrew: true } };
        const options = { config: { plugins: { enabled: false }, skills } };
        const check = async (eligible: boolean) => {
          const expected = {
            eligible,
            missing: {
              bins: eligible ? [] : ["fixture-tool"],
              anyBins: eligible ? [] : ["fixture-alt", "fixture-other"],
            },
            install: [{ id: eligible ? "brew" : "node" }],
          };
          for (const report of [
            buildWorkspaceSkillStatus(workspaceDir, options),
            (await prepareWorkspaceSkillStatus(workspaceDir, options)).report,
          ]) {
            expect(
              report.skills.filter(({ name }) => ["dependency", "second"].includes(name)),
            ).toMatchObject([expected, expected]);
          }
          const counts = eligible ? { eligible: 2, missing: 0 } : { eligible: 0, missing: 2 };
          expect(buildWorkspaceSkillReadiness(workspaceDir, options)).toEqual({
            workspaceDir,
            ...counts,
          });
        };
        await check(false);
        const version = getSkillsSnapshotVersion(workspaceDir);
        const binaries = ["fixture-tool", "fixture-alt", "brew"].map((name) =>
          path.join(binDir, process.platform === "win32" ? `${name}.CMD` : name),
        );
        await Promise.all(binaries.map((file) => fs.writeFile(file, "", { mode: 0o755 })));
        await check(true);
        await withEnvAsync({ PATH: path.join(workspaceDir, "other-bin") }, async () => {
          await check(false);
        });
        await Promise.all(binaries.map((file) => fs.unlink(file)));
        await check(false);
        expect(getSkillsSnapshotVersion(workspaceDir)).toBe(version);
      },
    );
  });

  it("preserves file facts and requested Skill Card content for caller-supplied entries", async () => {
    const content = "# Selected Skill Card\n";
    const { skillDir, cardPath } = await cardFixture(content);
    const entry = createEntry("selected", { baseDir: skillDir, source: "openclaw-workspace" });
    const result = await prepareWorkspaceSkillStatus(workspaceDir, {
      entries: [entry],
      skillCardKey: "selected",
      managedSkillsDir: path.join(workspaceDir, "managed"),
    });
    const skillCard = { present: true, path: cardPath, sizeBytes: Buffer.byteLength(content) };
    expect(result.report.skills).toMatchObject([{ name: "selected", skillCard }]);
    expect(result.files).toMatchObject([
      {
        name: "selected",
        filePath: entry.skill.filePath,
        skillCard: { ...skillCard, content },
      },
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

  it.each(process.platform === "win32" ? ["growth"] : ["growth", "fifo"])(
    "rejects a Skill Card changed after validation: %s",
    async (change) => {
      const { skillDir, cardPath, realCardPath } = await cardFixture();
      const maxBytes = 256 * 1024;
      const openSync = fsSync.openSync.bind(fsSync);
      const readSync = fsSync.readSync.bind(fsSync);
      let cardFd: number | undefined;
      let changed = false;
      let unsafeOpen = false;
      let bytesRead = 0;
      const growBeforeRead = (descriptor: unknown) => {
        if (change === "growth" && descriptor === cardFd && !changed) {
          changed = true;
          fsSync.appendFileSync(cardPath, "a".repeat(maxBytes));
        }
      };
      const openSpy = vi.spyOn(fsSync, "openSync").mockImplementation((target, flags, mode) => {
        const isCard = path.resolve(String(target)) === realCardPath;
        if (change === "fifo" && isCard) {
          if (typeof flags !== "number" || (flags & fsSync.constants.O_NONBLOCK) === 0) {
            unsafeOpen = true;
            throw new Error("Refusing a blocking FIFO fixture open");
          }
          fsSync.unlinkSync(realCardPath);
          execFileSync("mkfifo", [realCardPath]);
          changed = true;
        }
        const descriptor = openSync(target, flags, mode);
        if (cardFd === undefined && isCard) {
          cardFd = descriptor;
        }
        return descriptor;
      });
      const readSpy = vi.spyOn(fsSync, "readSync").mockImplementation((...args) => {
        growBeforeRead(args[0]);
        const count: number = Reflect.apply(readSync, fsSync, args);
        if (args[0] === cardFd) {
          bytesRead += count;
        }
        return count;
      });

      try {
        expect(readLocalSkillCardContentSync(skillDir)?.length).toBeUndefined();
        expect(changed).toBe(true);
        expect(unsafeOpen).toBe(false);
        if (change === "growth") {
          expect(bytesRead).toBeGreaterThan(0);
          expect(bytesRead).toBeLessThanOrEqual(maxBytes + 1);
        }
      } finally {
        readSpy.mockRestore();
        openSpy.mockRestore();
      }
    },
  );

  it("surfaces malformed or mismatched ClawHub linkage without trusting it", async () => {
    const skillDir = (name: string) => path.join(workspaceDir, "skills", name);
    const malformedDir = skillDir("malformed");

    await fs.mkdir(path.join(malformedDir, ".clawhub"), { recursive: true });
    await fs.writeFile(path.join(malformedDir, ".clawhub", "origin.json"), "{not json", "utf8");
    await writeClawHubStatusFixture(workspaceDir, skillDir("copied"), "mismatch");

    for (const [name, version] of [
      ["missing-lock", false],
      ["mismatch", "9.9.9"],
    ] as const) {
      await writeClawHubStatusFixture(workspaceDir, skillDir(name), name, version);
    }

    const report = buildWorkspaceSkillStatus(workspaceDir, {
      entries: ["malformed", "missing-lock", "mismatch", "local-only", "copied"].map((name) =>
        createEntry(name, { baseDir: skillDir(name) }),
      ),
    });
    const [malformed, missing, mismatch, local, copied] = report.skills;

    expectInvalidLink(malformed, "Malformed ClawHub origin metadata");
    expectInvalidLink(missing, "not tracked by the workspace ClawHub lockfile");
    expectInvalidLink(mismatch, "does not match the workspace ClawHub lockfile");
    expectInvalidLink(copied, "expected ClawHub install directory", "mismatch");
    expect(local).toMatchObject({ name: "local-only" });
    expect(local?.clawhub).toBeUndefined();
    expect(local?.skillCard).toBeUndefined();
  });

  it.each(process.platform === "win32" ? [false] : [false, true])(
    "requires a managed lockfile and follows a linked install directory: %s",
    async (linked) => {
      const managedParentDir = tempDirs.make("openclaw-managed-");
      const managedSkillsDir = path.join(managedParentDir, "skills");
      const installDir = path.join(managedSkillsDir, "global-skill");
      const skillDir = linked ? tempDirs.make("openclaw-skill-target-") : installDir;
      await fs.mkdir(managedSkillsDir, { recursive: true });
      await writeSkill({ dir: skillDir, name: "global-skill", description: "Global skill" });
      if (linked) {
        await fs.symlink(skillDir, installDir);
      }
      await writeClawHubStatusFixture(
        managedParentDir,
        skillDir,
        "global-skill",
        linked ? "1.2.3" : false,
      );

      const report = buildWorkspaceSkillStatus(workspaceDir, { managedSkillsDir });
      const skill = report.skills.find((entry) => entry.skillKey === "global-skill");
      if (linked) {
        expect(skill).toMatchObject({
          source: "openclaw-managed",
          baseDir: await fs.realpath(skillDir),
          clawhub: {
            status: "linked",
            valid: true,
            lockPath: path.join(managedParentDir, ".clawhub", "lock.json"),
          },
        });
      } else {
        expectInvalidLink(skill, "not tracked by the managed ClawHub lockfile");
      }
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
    expect(report.skills[0]?.configChecks).toEqual([
      { path: "channels.discord.token", satisfied: true },
    ]);
  });

  it("preserves source, keys, order and distinct visibility reasons in a mixed skill pack", () => {
    const missingBin = "openclaw-test-definitely-missing-skill-bin";
    const env = "OPENCLAW_TEST_MISSING_SKILL_KEY";
    const pkg = "@openclaw/missing-skill-bin";
    const visible = { eligible: true, modelVisible: true, commandVisible: true };
    const hidden = { eligible: false, modelVisible: false, commandVisible: false };
    const cases: Array<[string, Parameters<typeof createEntry>[1], Partial<SkillStatus>]> = [
      [
        "ready",
        {
          source: "openclaw-workspace",
          metadata: { skillKey: "workspace-key" },
          exposure: { includeInRuntimeRegistry: true } as SkillEntry["exposure"],
        },
        {
          ...visible,
          source: "openclaw-workspace",
          skillKey: "workspace-key",
          bundled: false,
          blockedByAgentFilter: false,
          userInvocable: true,
        },
      ],
      [
        "needs-bin",
        {
          metadata: {
            requires: { bins: [missingBin] },
            install: [{ kind: "node", package: pkg, bins: [missingBin] }],
          },
        },
        {
          ...hidden,
          missing: { ...noMissing, bins: [missingBin] },
          install: [
            { kind: "node", id: "node-0", label: `Install ${pkg} (pnpm)`, bins: [missingBin] },
          ],
        },
      ],
      [
        "needs-env",
        { metadata: { primaryEnv: env, requires: { env: [env] } } },
        { eligible: false, primaryEnv: env, missing: { ...noMissing, env: [env] } },
      ],
      [
        "prompt-hidden",
        { invocation: { userInvocable: true, disableModelInvocation: true } },
        { ...visible, modelVisible: false },
      ],
      [
        "slash-hidden",
        { invocation: { userInvocable: false, disableModelInvocation: false } },
        { ...visible, commandVisible: false, userInvocable: false },
      ],
      ["disabled", {}, { ...hidden, disabled: true }],
      [
        "bundled-blocked",
        { source: "openclaw-bundled" },
        {
          ...hidden,
          source: "openclaw-bundled",
          skillKey: "bundled-blocked",
          bundled: true,
          blockedByAllowlist: true,
        },
      ],
      [
        "custodian",
        { source: "openclaw-custodian" },
        {
          ...visible,
          modelVisible: false,
          commandVisible: false,
          source: "openclaw-custodian",
          skillKey: "custodian",
          bundled: true,
          blockedByAgentFilter: true,
        },
      ],
    ];
    const skills = cases.map(([name]) => name).filter((name) => name !== "custodian");
    const report = buildWorkspaceSkillStatus(workspaceDir, {
      agentId: "specialist",
      config: {
        agents: { entries: { specialist: { skills } } },
        skills: {
          allowBundled: ["custodian"],
          entries: { disabled: { enabled: false } },
          install: { nodeManager: "pnpm" },
        },
      },
      entries: cases.map(([name, options]) => createEntry(name, options)),
    });

    expect(report).toMatchObject({ agentId: "specialist", agentSkillFilter: skills });
    expect(report.skills).toHaveLength(cases.length);
    cases.forEach(([name, , expected], index) => {
      const skill = report.skills[index];
      expect(skill).toMatchObject({ name, ...expected });
      if (expected.missing) {
        expect(skill?.missing).toStrictEqual(expected.missing);
      }
      if (expected.install) {
        expect(skill?.install).toStrictEqual(expected.install);
      }
    });
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
    skills: { [slug]: { version: lockVersion, ...common } },
  });
}
