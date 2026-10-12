import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  archiveWorkshopSkill,
  createWorkshopSkill,
  listWorkshopArchive,
  listWorkshopChanges,
  listWorkshopSkills,
  patchWorkshopSkill,
  restoreWorkshopSkill,
  viewWorkshopSkill,
  WorkshopWriteError,
  writeWorkshopSkillFile,
  type WorkshopMutationContext,
} from "./library.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";

let state: OpenClawTestState;
let ctx: WorkshopMutationContext;

const skill = (name: string, body: string, description = "Deploy staging builds") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only" });
  ctx = {
    config: {},
    agentId: "main",
    actor: "agent",
    sessionKey: "agent:main:main",
    runId: "run-1",
  };
});

afterEach(async () => {
  await state.cleanup();
});

async function readLive(name: string) {
  return (await viewWorkshopSkill({}, "main", name)).content;
}

describe("workshop library", () => {
  it("reuses retained changes across runs and refreshes after a workshop write", async () => {
    const reads = vi.spyOn(stateWorker, "executeOpenClawStateWorker");
    try {
      expect(await listWorkshopChanges("main", { runId: "before" })).toEqual([]);
      const count = reads.mock.calls.length;
      expect(await listWorkshopChanges("main", { runId: "another" })).toEqual([]);
      expect(reads.mock.calls).toHaveLength(count);

      await createWorkshopSkill(ctx, { name: "deploy", content: skill("deploy", "1. Deploy.") });
      const changes = await listWorkshopChanges("main", { runId: "run-1" });
      expect(changes).toMatchObject([{ action: "create", skillName: "deploy" }]);
      changes[0]!.summary = "caller mutation";
      expect(await listWorkshopChanges("main", { beforeMs: changes[0]!.createdAtMs })).toEqual([]);
      expect(await listWorkshopChanges("main", { runId: "run-1" })).toMatchObject([
        { summary: "created: Deploy staging builds" },
      ]);
    } finally {
      reads.mockRestore();
    }
  });

  it("versions every mutation so restore undoes it, and undoing the undo is possible", async () => {
    await createWorkshopSkill(ctx, {
      name: "deploy",
      content: skill("deploy", "1. Run make deploy."),
    });
    const patched = await patchWorkshopSkill(ctx, {
      name: "deploy",
      oldText: "make deploy",
      newText: "make deploy ENV=staging",
      summary: "pinned staging env",
    });
    expect(patched.versionId).toMatch(/^\d{8}T\d{9}Z-patch$/);
    expect(await readLive("deploy")).toContain("make deploy ENV=staging");

    const undo = await restoreWorkshopSkill(ctx, { name: "deploy" });
    expect(await readLive("deploy")).toContain("1. Run make deploy.\n");
    expect(undo.versionId).toMatch(/-restore$/);

    await restoreWorkshopSkill(ctx, { name: "deploy" });
    expect(await readLive("deploy")).toContain("make deploy ENV=staging");

    const changes = await listWorkshopChanges("main", { runId: "run-1" });
    expect(changes.map((change) => [change.action, change.actor])).toEqual([
      ["restore", "agent"],
      ["restore", "agent"],
      ["patch", "agent"],
      ["create", "agent"],
    ]);
    expect(changes[2]).toMatchObject({
      summary: "pinned staging env",
      sessionKey: "agent:main:main",
    });
    expect(changes[3]).toMatchObject({ summary: "created: Deploy staging builds" });
    expect(changes[3]?.versionId).toBeUndefined();
    expect(await listWorkshopChanges("main", { runId: "other-run" })).toEqual([]);
  });

  it("archives into a restorable version and hides the skill from the live list", async () => {
    await createWorkshopSkill(ctx, { name: "deploy", content: skill("deploy", "1. Deploy.") });
    await createWorkshopSkill(ctx, { name: "release", content: skill("release", "1. Release.") });
    await writeWorkshopSkillFile(ctx, {
      name: "deploy",
      filePath: "references/hosts.md",
      content: "staging.example.test\n",
    });

    await expect(
      archiveWorkshopSkill(ctx, { name: "deploy", absorbedInto: "missing" }),
    ).rejects.toThrow(/absorbed_into must name another live workshop skill/);
    const archived = await archiveWorkshopSkill(ctx, { name: "deploy", absorbedInto: "release" });
    expect(archived.summary).toBe("archived: merged into release");
    expect((await listWorkshopSkills({}, "main")).map((entry) => entry.name)).toEqual(["release"]);
    const [entry] = await listWorkshopArchive({}, "main");
    expect(entry).toMatchObject({ name: "deploy", live: false });
    expect(entry?.versions[0]?.action).toBe("archive");
    await expect(viewWorkshopSkill({}, "main", "deploy")).rejects.toThrow(/is archived/);

    await restoreWorkshopSkill(ctx, { name: "deploy" });
    const restored = await viewWorkshopSkill({}, "main", "deploy", "references/hosts.md");
    expect(restored.content).toBe("staging.example.test\n");
    expect(restored.files).toEqual(["SKILL.md", "references/hosts.md"]);

    // The merge target stays locked, so archiving it first refuses the merge instead of racing.
    const [target, merge] = await Promise.allSettled([
      archiveWorkshopSkill(ctx, { name: "release" }),
      archiveWorkshopSkill(ctx, { name: "deploy", absorbedInto: "release" }),
    ]);
    expect(target.status).toBe("fulfilled");
    expect(merge).toMatchObject({ status: "rejected", reason: expect.any(WorkshopWriteError) });
    expect((await listWorkshopSkills({}, "main")).map((live) => live.name)).toEqual(["deploy"]);
  });

  it("refuses invalid or unsafe writes with actionable errors and leaves files untouched", async () => {
    await expect(
      createWorkshopSkill(ctx, { name: "Deploy", content: skill("Deploy", "x") }),
    ).rejects.toThrow(/Invalid skill name/);
    await expect(
      createWorkshopSkill(ctx, { name: "deploy", content: skill("other", "x") }),
    ).rejects.toThrow(/must contain "name: deploy"/);
    await expect(
      createWorkshopSkill(ctx, { name: "deploy", content: skill("deploy", "x", "d".repeat(1025)) }),
    ).rejects.toThrow(/description" must be 1-1024 bytes/);
    const token = `ghp_${"A".repeat(30)}`;
    await expect(
      createWorkshopSkill(ctx, {
        name: "deploy",
        content: skill("deploy", `export TOKEN=${token}`),
      }),
    ).rejects.toThrow(/literal-secret.*placeholder/);
    await expect(
      fs.stat(path.join(resolveWorkshopSkillsDir({}, "main"), "deploy")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await createWorkshopSkill(ctx, { name: "deploy", content: skill("deploy", "run it\nrun it") });
    await expect(
      patchWorkshopSkill(ctx, { name: "deploy", oldText: "run it", newText: "run" }),
    ).rejects.toThrow(/matches 2 places/);
    await expect(
      writeWorkshopSkillFile(ctx, { name: "deploy", filePath: "../escape.md", content: "x" }),
    ).rejects.toBeInstanceOf(WorkshopWriteError);
    await expect(
      writeWorkshopSkillFile(ctx, {
        name: "deploy",
        filePath: `references/${token}.md`,
        content: "x",
      }),
    ).rejects.toThrow(/file path in "deploy" looks like it contains a credential/);
    await expect(
      writeWorkshopSkillFile(ctx, {
        name: "deploy",
        filePath: "SKILL.md",
        content: "no frontmatter",
      }),
    ).rejects.toThrow(/must contain "name: deploy"/);
    expect(await readLive("deploy")).toBe(skill("deploy", "run it\nrun it"));
    expect(await listWorkshopArchive({}, "main")).toEqual([]);
  });

  it("never lists or reads a symlinked saved version", async () => {
    await createWorkshopSkill(ctx, { name: "deploy", content: skill("deploy", "step 1") });
    const outside = path.join(state.root, "outside");
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "SKILL.md"), "secret host file\n");
    const versionsDir = path.join(resolveWorkshopSkillsDir({}, "main"), ".archive", "deploy");
    await fs.mkdir(versionsDir, { recursive: true });
    const id = "20260101T000000000Z-patch";
    await fs.symlink(outside, path.join(versionsDir, id));

    expect(await listWorkshopArchive({}, "main")).toEqual([]);
    await expect(viewWorkshopSkill({}, "main", "deploy", undefined, id)).rejects.toThrow(
      /has no version/,
    );
  });

  it("refuses to restore a tampered saved version and leaves the live skill untouched", async () => {
    await createWorkshopSkill(ctx, { name: "deploy", content: skill("deploy", "step 1") });
    const { versionId = "" } = await patchWorkshopSkill(ctx, {
      name: "deploy",
      oldText: "step 1",
      newText: "step 2",
    });
    const versionDir = path.join(
      resolveWorkshopSkillsDir({}, "main"),
      ".archive",
      "deploy",
      versionId,
    );
    const restore = () => restoreWorkshopSkill(ctx, { name: "deploy" });

    await fs.writeFile(path.join(versionDir, "SKILL.md"), "no frontmatter\n");
    await expect(restore()).rejects.toThrow(/Cannot restore "deploy".*must contain "name: deploy"/);
    await fs.writeFile(path.join(versionDir, "SKILL.md"), skill("deploy", "step 1"));
    await fs.mkdir(path.join(versionDir, "references"));
    await fs.writeFile(
      path.join(versionDir, "references", "env.md"),
      `TOKEN=ghp_${"A".repeat(30)}`,
    );
    await expect(restore()).rejects.toThrow(/Cannot restore "deploy".*literal-secret/);
    await fs.rm(path.join(versionDir, "references", "env.md"));
    await fs.symlink("/etc/hosts", path.join(versionDir, "references", "hosts.md"));
    await expect(restore()).rejects.toThrow(/references\/hosts\.md is a symlink/);

    expect(await readLive("deploy")).toBe(skill("deploy", "step 2"));
    const [entry] = await listWorkshopArchive({}, "main");
    expect(entry?.versions.map((version) => version.id)).toEqual([versionId]);
  });

  it("keeps the newest ten versions per skill", async () => {
    await createWorkshopSkill(ctx, { name: "deploy", content: skill("deploy", "step 0") });
    for (let step = 1; step <= 12; step += 1) {
      await patchWorkshopSkill(ctx, {
        name: "deploy",
        oldText: `step ${step - 1}`,
        newText: `step ${step}`,
      });
    }
    const [entry] = await listWorkshopArchive({}, "main");
    expect(entry?.versions).toHaveLength(10);
    const oldest = entry?.versions.at(-1)?.id ?? "";
    const view = await viewWorkshopSkill({}, "main", "deploy", undefined, oldest);
    expect(view.content).toContain("step 2");
  });

  it.each(["patch", "archive"] as const)(
    "does not %s once authority is revoked during the snapshot",
    async (action) => {
      await createWorkshopSkill(ctx, { name: "deploy", content: skill("deploy", "step 0") });
      // Live at lock time; revoked by the time the snapshot copy finishes.
      let checks = 0;
      const revoking = {
        ...ctx,
        assertLive: () => {
          checks += 1;
          if (checks > 1) {
            throw new Error("Learning is off.");
          }
        },
      };
      await expect(
        action === "patch"
          ? patchWorkshopSkill(revoking, { name: "deploy", oldText: "step 0", newText: "step 1" })
          : archiveWorkshopSkill(revoking, { name: "deploy", reason: "unused" }),
      ).rejects.toThrow("Learning is off.");
      expect(await readLive("deploy")).toContain("step 0");
      expect(await listWorkshopArchive({}, "main")).toEqual([]);
    },
  );

  it("keeps the live skill when restore is revoked between the swap's two renames", async () => {
    await createWorkshopSkill(ctx, { name: "deploy", content: skill("deploy", "step 0") });
    await patchWorkshopSkill(ctx, { name: "deploy", oldText: "step 0", newText: "step 1" });
    // Lock time, snapshot publish and the first swap check pass; the final publish is refused.
    let checks = 0;
    const revoking = {
      ...ctx,
      assertLive: () => {
        checks += 1;
        if (checks > 3) {
          throw new Error("Learning is off.");
        }
      },
    };
    await expect(restoreWorkshopSkill(revoking, { name: "deploy" })).rejects.toThrow(
      "Learning is off.",
    );
    expect(await readLive("deploy")).toContain("step 1");
  });

  it("keeps a longer legacy skill manageable while new names stay within 63 characters", async () => {
    // Earlier releases wrote learned skills under normalized names with no length cap.
    const legacy = `deploy-${"staging-".repeat(8)}env`;
    expect(legacy.length).toBeGreaterThan(63);
    const skillDir = path.join(resolveWorkshopSkillsDir({}, "main"), legacy);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), skill(legacy, "step 0"));

    expect((await listWorkshopSkills({}, "main")).map((live) => live.name)).toEqual([legacy]);
    await patchWorkshopSkill(ctx, { name: legacy, oldText: "step 0", newText: "step 1" });
    expect(await readLive(legacy)).toContain("step 1");
    await archiveWorkshopSkill(ctx, { name: legacy, reason: "superseded" });
    expect((await listWorkshopArchive({}, "main")).map((entry) => entry.name)).toEqual([legacy]);
    await restoreWorkshopSkill(ctx, { name: legacy });
    expect(await readLive(legacy)).toContain("step 1");

    await expect(
      createWorkshopSkill(ctx, { name: `${legacy}-copy`, content: skill(`${legacy}-copy`, "x") }),
    ).rejects.toThrow(/use 1-63 lowercase letters/);
  });
});
