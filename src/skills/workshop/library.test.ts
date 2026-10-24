import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalizePath } from "../../agents/utils/paths.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { makeCronJob } from "../../cron/delivery.test-helpers.js";
import { resolveCronJobsStorePath, saveCronJobsStore } from "../../cron/store.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
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
import { registerSkillUsageTracking } from "./skill-usage.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";
import { archiveUnusedWorkshopSkills } from "./unused-archive.js";

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
  vi.restoreAllMocks();
  await state.cleanup();
});

async function readLive(name: string) {
  return (await viewWorkshopSkill({}, "main", name)).content;
}
const create = (body: string, name = "deploy", description?: string) =>
  createWorkshopSkill(ctx, { name, content: skill(name, body, description) });
const patch = (oldText: string, newText: string, context = ctx, name = "deploy") =>
  patchWorkshopSkill(context, { name, oldText, newText });
const write = (filePath: string, content: string) =>
  writeWorkshopSkillFile(ctx, { name: "deploy", filePath, content });
const view = (filePath?: string, versionId?: string) =>
  viewWorkshopSkill({}, "main", "deploy", filePath, versionId);
const versions = () => listWorkshopArchive({}, "main");
const liveNames = async () => (await listWorkshopSkills({}, "main")).map(({ name }) => name);
const skillPath = (...parts: string[]) => path.join(resolveWorkshopSkillsDir({}, "main"), ...parts);
const restore = (context = ctx) => restoreWorkshopSkill(context, { name: "deploy" });
const archive = (absorbedInto?: string) =>
  archiveWorkshopSkill(ctx, { name: "deploy", absorbedInto });
async function seed(name: string, content: string | Buffer) {
  const dir = skillPath(name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), content);
}
const refuses = (operation: Promise<unknown>, error: string | RegExp) =>
  expect(operation).rejects.toThrow(error);
function revokedAfter(allowed: number): WorkshopMutationContext {
  let checks = 0;
  return {
    ...ctx,
    assertLive: () => {
      if (++checks > allowed) {
        throw new Error("Learning is off.");
      }
    },
  };
}
async function createPatched() {
  await create("step 0");
  return patch("step 0", "step 1");
}

it("reports unreadable skill files instead of returning an incomplete inventory", async () => {
  await seed("oversized", Buffer.alloc(1024 * 1024 + 1, "x"));
  await refuses(listWorkshopSkills({}, "main"), /file exceeds limit of 1048576 bytes/);
});

it("skips directories without SKILL.md but still lists hand-edited broken frontmatter", async () => {
  await fs.mkdir(skillPath("missing"), { recursive: true });
  await seed("broken", "---\nname: [\n---\n");
  await fs.symlink(skillPath("broken"), skillPath("broken", "loop"), "dir");
  await fs.symlink(skillPath("broken", "SKILL.md"), skillPath("broken", "linked.md"), "file");

  expect(await listWorkshopSkills({}, "main")).toMatchObject([
    { name: "broken", description: "", files: ["SKILL.md"] },
  ]);
});

it("reuses retained changes across runs and refreshes after a workshop write", async () => {
  const reads = vi.spyOn(stateWorker, "executeOpenClawStateWorker");
  expect(await listWorkshopChanges("main", { runId: "before" })).toEqual([]);
  const count = reads.mock.calls.length;
  expect(await listWorkshopChanges("main", { runId: "another" })).toEqual([]);
  expect(reads.mock.calls).toHaveLength(count);

  await create("1. Deploy.");
  const changes = await listWorkshopChanges("main", { runId: "run-1" });
  expect(changes).toMatchObject([{ action: "create", skillName: "deploy" }]);
  changes[0]!.summary = "caller mutation";
  expect(await listWorkshopChanges("main", { beforeMs: changes[0]!.createdAtMs })).toEqual([]);
  expect(await listWorkshopChanges("main", { runId: "run-1" })).toMatchObject([
    { summary: "created: Deploy staging builds" },
  ]);
});

it("versions every mutation so restore undoes it, and undoing the undo is possible", async () => {
  await create("1. Run make deploy.");
  const patched = await patchWorkshopSkill(ctx, {
    name: "deploy",
    oldText: "make deploy",
    newText: "make deploy ENV=staging",
    summary: "pinned staging env",
  });
  expect(patched.versionId).toMatch(/^\d{8}T\d{9}Z-patch$/);
  expect(await readLive("deploy")).toContain("make deploy ENV=staging");

  const undo = await restore();
  expect(await readLive("deploy")).toContain("1. Run make deploy.\n");
  expect(undo.versionId).toMatch(/-restore$/);

  await restore();
  expect(await readLive("deploy")).toContain("make deploy ENV=staging");

  const changes = await listWorkshopChanges("main", { runId: "run-1" });
  expect(changes).toMatchObject([
    { action: "restore", actor: "agent" },
    { action: "restore", actor: "agent" },
    {
      action: "patch",
      actor: "agent",
      summary: "pinned staging env",
      sessionKey: "agent:main:main",
    },
    { action: "create", actor: "agent", summary: "created: Deploy staging builds" },
  ]);
  expect(changes[3]?.versionId).toBeUndefined();
  expect(await listWorkshopChanges("main", { runId: "other-run" })).toEqual([]);
});

it("archives into a restorable version and hides the skill from the live list", async () => {
  await create("1. Deploy.");
  await create("1. Release.", "release");
  await write("references/hosts.md", "staging.example.test\n");

  await refuses(archive("missing"), /absorbed_into must name another live workshop skill/);
  const archived = await archive("release");
  expect(archived.summary).toBe("archived: merged into release");
  expect(await liveNames()).toEqual(["release"]);
  const [entry] = await versions();
  expect(entry).toMatchObject({ name: "deploy", live: false });
  expect(entry?.versions[0]?.action).toBe("archive");
  await refuses(view(), /is archived/);

  await restore();
  const restored = await view("references/hosts.md");
  expect(restored.content).toBe("staging.example.test\n");
  expect(restored.files).toEqual(["SKILL.md", "references/hosts.md"]);

  // The merge target stays locked, so archiving it first refuses the merge instead of racing.
  const [target, merge] = await Promise.allSettled([
    archiveWorkshopSkill(ctx, { name: "release" }),
    archive("release"),
  ]);
  expect(target.status).toBe("fulfilled");
  expect(merge).toMatchObject({ status: "rejected", reason: expect.any(WorkshopWriteError) });
  expect(await liveNames()).toEqual(["deploy"]);
});

it("refuses invalid or unsafe writes with actionable errors and leaves files untouched", async () => {
  await refuses(create("x", "Deploy"), /Invalid skill name/);
  await refuses(
    createWorkshopSkill(ctx, { name: "deploy", content: skill("other", "x") }),
    /must contain "name: deploy"/,
  );
  await refuses(create("x", "deploy", "d".repeat(1025)), /description" must be 1-1024 bytes/);
  const token = `ghp_${"A".repeat(30)}`;
  await refuses(create(`export TOKEN=${token}`), /literal-secret.*placeholder/);
  await expect(fs.stat(skillPath("deploy"))).rejects.toMatchObject({ code: "ENOENT" });

  await create("run it\nrun it");
  await refuses(patch("run it", "run"), /matches 2 places/);
  await expect(write("../escape.md", "x")).rejects.toBeInstanceOf(WorkshopWriteError);
  await refuses(
    write(`references/${token}.md`, "x"),
    /file path in "deploy" looks like it contains a credential/,
  );
  await refuses(write("SKILL.md", "no frontmatter"), /must contain "name: deploy"/);
  expect(await readLive("deploy")).toBe(skill("deploy", "run it\nrun it"));
  expect(await versions()).toEqual([]);
});

it("refuses support writes into dependency directories before creating files or versions", async () => {
  await create("Visible procedure");
  for (const file of ["scripts/node_modules/x.js", "references/cache/node_modules/x.md"]) {
    await refuses(write(file, "hidden content"), /node_modules.*not a skill support directory/);
    await expect(fs.stat(skillPath("deploy", ...file.split("/")))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
  expect((await view()).files).toEqual(["SKILL.md"]);
  expect(await versions()).toEqual([]);
});

it("rejects a patch whose old text matches overlapping places", async () => {
  await create("run\nrun\nrun");
  await refuses(patch("run\nrun", "go"), /matches 2 places/);
  expect(await readLive("deploy")).toBe(skill("deploy", "run\nrun\nrun"));
});

it("never lists or reads a symlinked saved version", async () => {
  await create("step 1");
  const outside = path.join(state.root, "outside");
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, "SKILL.md"), "secret host file\n");
  const versionsDir = skillPath(".archive", "deploy");
  await fs.mkdir(versionsDir, { recursive: true });
  const id = "20260101T000000000Z-patch";
  await fs.symlink(outside, path.join(versionsDir, id));

  expect(await versions()).toEqual([]);
  await refuses(view(undefined, id), /has no version/);
});

it("refuses to restore a tampered saved version and leaves the live skill untouched", async () => {
  await create("step 1");
  const { versionId = "" } = await patch("step 1", "step 2");
  const versionDir = skillPath(".archive", "deploy", versionId);

  await fs.writeFile(path.join(versionDir, "SKILL.md"), "no frontmatter\n");
  await refuses(restore(), /Cannot restore "deploy".*must contain "name: deploy"/);
  await fs.writeFile(path.join(versionDir, "SKILL.md"), skill("deploy", "step 1"));
  await fs.mkdir(path.join(versionDir, "references"));
  await fs.writeFile(path.join(versionDir, "references", "env.md"), `TOKEN=ghp_${"A".repeat(30)}`);
  await refuses(restore(), /Cannot restore "deploy".*literal-secret/);
  await fs.rm(path.join(versionDir, "references", "env.md"));
  await fs.symlink("/etc/hosts", path.join(versionDir, "references", "hosts.md"));
  await refuses(restore(), /references\/hosts\.md is a symlink/);

  expect(await readLive("deploy")).toBe(skill("deploy", "step 2"));
  const [entry] = await versions();
  expect(entry?.versions.map((version) => version.id)).toEqual([versionId]);
});

it("keeps the newest ten versions per skill", async () => {
  await create("step 0");
  for (let step = 1; step <= 12; step += 1) {
    await patch(`step ${step - 1}`, `step ${step}`);
  }
  const [entry] = await versions();
  expect(entry?.versions).toHaveLength(10);
  const oldest = entry?.versions.at(-1)?.id ?? "";
  expect((await view(undefined, oldest)).content).toContain("step 2");
});

it.each(["patch", "archive"] as const)(
  "does not %s once authority is revoked during the snapshot",
  async (action) => {
    await create("step 0");
    // Live at lock time; revoked by the time the snapshot copy finishes.
    const revoking = revokedAfter(1);
    await refuses(
      action === "patch"
        ? patch("step 0", "step 1", revoking)
        : archiveWorkshopSkill(revoking, { name: "deploy", reason: "unused" }),
      "Learning is off.",
    );
    expect(await readLive("deploy")).toContain("step 0");
    expect(await versions()).toEqual([]);
  },
);

it("keeps the live skill when restore is revoked between the swap's two renames", async () => {
  await createPatched();
  // Lock time, snapshot publish and the first swap check pass; the final publish is refused.
  await refuses(restore(revokedAfter(3)), "Learning is off.");
  expect(await readLive("deploy")).toContain("step 1");
});

it("retains the original live copy when restore publication and rollback both fail", async () => {
  await createPatched();
  const live = skillPath("deploy");
  let previous = "";
  const rename = fs.rename;
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (from === live) {
      previous = String(to);
    } else if (to === live) {
      throw new Error(from === previous ? "rollback blocked" : "publication blocked");
    }
    await rename(from, to);
  });
  await refuses(restore(), "rollback blocked");
  expect(previous).toContain(".restore-previous-");
  expect(await fs.readFile(path.join(previous, "SKILL.md"), "utf8")).toBe(
    skill("deploy", "step 1"),
  );
});

it("keeps a longer legacy skill manageable while new names stay within 63 characters", async () => {
  const legacy = `deploy-${"staging-".repeat(8)}env`;
  expect(legacy.length).toBeGreaterThan(63);
  await seed(legacy, skill(legacy, "step 0"));

  expect(await liveNames()).toEqual([legacy]);
  await patch("step 0", "step 1", ctx, legacy);
  expect(await readLive(legacy)).toContain("step 1");
  await archiveWorkshopSkill(ctx, { name: legacy, reason: "superseded" });
  expect((await versions()).map((entry) => entry.name)).toEqual([legacy]);
  await restoreWorkshopSkill(ctx, { name: legacy });
  expect(await readLive(legacy)).toContain("step 1");

  await refuses(create("x", `${legacy}-copy`), /use 1-63 lowercase letters/);
});

describe("archiveUnusedWorkshopSkills", () => {
  const DAY_MS = 24 * 60 * 60_000;
  function agentConfig(runtime = "openclaw", sandbox?: "non-main"): OpenClawConfig {
    return {
      agents: {
        defaults: {
          model: "anthropic/claude-test",
          models: { "anthropic/*": { agentRuntime: { id: runtime } } },
          ...(sandbox ? { sandbox: { mode: sandbox } } : {}),
        },
      },
    };
  }
  const config = agentConfig();
  let stopTracking: (() => Promise<void>) | undefined;
  const archiveUnused = (cfg = config, now = Date.now() + 31 * DAY_MS) =>
    archiveUnusedWorkshopSkills(cfg, "main", now);
  const createNamed = (name: string) => create("1. Do it.", name, `${name} steps`);
  beforeEach(() => {
    ctx = { config, agentId: "main", actor: "agent" };
    setRuntimeConfigSnapshot(config);
    stopTracking = registerSkillUsageTracking();
  });
  afterEach(async () => {
    await stopTracking?.();
    stopTracking = undefined;
  });

  it("archives only learned skills unused for 30 days, as an undoable change", async () => {
    const createdAtMs = Date.now();
    await createNamed("stale");
    await createNamed("used");
    expect(await archiveUnused(config, createdAtMs + 29 * DAY_MS)).toEqual([]);
    await stateWorker.executeOpenClawStateWorker(captureOpenClawStateWorkerContext(), {
      type: "skills.usage.record",
      input: {
        skillFile: canonicalizePath(skillPath("used", "SKILL.md")),
        skillKey: "used",
        skillName: "used",
        skillSource: "workspace",
        agentId: "main",
        ts: createdAtMs + 20 * DAY_MS,
      },
    });
    expect(await archiveUnused(config, createdAtMs + 31 * DAY_MS)).toMatchObject([
      {
        skillName: "stale",
        action: "archive",
        actor: "curator",
        summary: "archived: unused for 30 days",
        versionId: expect.any(String),
      },
    ]);
    expect(await liveNames()).toEqual(["used"]);
    await restoreWorkshopSkill({ config, agentId: "main", actor: "user" }, { name: "stale" });
    expect(await liveNames()).toEqual(["stale", "used"]);
  });

  it("keeps a skill that a cron job names, even a paused one", async () => {
    await createNamed("quarterly-taxes");
    await createNamed("quarterly-taxes-old");
    await saveCronJobsStore(resolveCronJobsStorePath(), {
      version: 1,
      jobs: [
        makeCronJob({
          enabled: false,
          payload: {
            kind: "agentTurn",
            message: "Use the quarterly-taxes skill to file.",
          },
        }),
      ],
    });
    expect((await archiveUnused()).map((change) => change.skillName)).toEqual([
      "quarterly-taxes-old",
    ]);
  });

  it.each(["runtime", "sandbox", "tracking", "learning"] as const)(
    "fails closed at the %s guard",
    async (guard) => {
      await createNamed("stale");
      const cfg = agentConfig(
        guard === "runtime" ? "codex" : "openclaw",
        guard === "sandbox" ? "non-main" : undefined,
      );
      if (guard === "tracking") {
        await stopTracking?.();
        stopTracking = undefined;
      }
      if (guard === "learning") {
        setRuntimeConfigSnapshot({
          ...config,
          skills: { workshop: { autonomous: { mode: "off" } } },
        });
      }
      expect(await archiveUnused(cfg)).toEqual([]);
      expect(await liveNames()).toEqual(["stale"]);
    },
  );
});

it("prunes hidden and dependency directories before inventory budgets are consumed", async () => {
  await seed("deploy", skill("deploy", "Visible procedure"));
  await fs.mkdir(skillPath("deploy", "references"));
  await fs.writeFile(skillPath("deploy", "references", "kept.md"), "support");
  for (const ignored of [".git", ".venv", "node_modules"]) {
    const tooDeep = skillPath("deploy", ignored, ...Array(65).fill("nested"));
    await fs.mkdir(tooDeep, { recursive: true });
    await fs.writeFile(path.join(tooDeep, "ignored.md"), "not skill content");
  }
  expect(await listWorkshopSkills({}, "main")).toMatchObject([
    {
      name: "deploy",
      files: ["SKILL.md", "references/kept.md"],
      sizeBytes: Buffer.byteLength(skill("deploy", "Visible procedure")) + 7,
    },
  ]);
  expect((await view()).files).toEqual(["SKILL.md", "references/kept.md"]);
});
