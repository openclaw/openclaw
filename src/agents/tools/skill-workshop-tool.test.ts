import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { consumeRunSkillUsage } from "../../skills/runtime/run-usage.js";
import { listWorkshopArchive, listWorkshopChanges } from "../../skills/workshop/library.js";
import { resolveWorkshopDraftsDir } from "../../skills/workshop/skills-root.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createSkillWorkshopTool, type SkillWorkshopToolOptions } from "./skill-workshop-tool.js";

let state: OpenClawTestState;

beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only" });
  setRuntimeConfigSnapshot({});
  await workshop()("create", {
    content: "---\nname: deploy\ndescription: Deploy staging\n---\n\n1. Run make deploy.\n",
  });
});

afterEach(async () => {
  await state.cleanup();
  clearRuntimeConfigSnapshot();
});

const patch = { old_text: "make deploy", new_text: "make ship" };
const supportFile = { file_path: "references/old.md", content: "stale notes\n" };

function workshop(options: Omit<SkillWorkshopToolOptions, "config" | "agentId"> = {}) {
  const tool = createSkillWorkshopTool({ config: {}, agentId: "main", ...options });
  return async (action: string, params: Record<string, unknown> = {}, signal?: AbortSignal) => {
    const result = await tool.execute(action, { action, name: "deploy", ...params }, signal);
    return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  };
}

describe("skill_workshop", () => {
  it("requires viewing an existing skill before a background run edits or archives it", async () => {
    const tool = workshop({ runId: "review-run", reviewOf: "agent:main:main" });

    await expect(tool("patch", patch)).rejects.toThrow("View it first");
    // Retries rebuild the tool inside the same run; the read must carry over.
    await tool("view");
    const retried = workshop({
      sessionKey: "agent:main:internal-session-effects:skill-workshop-review_1",
      runId: "review-run",
      reviewOf: "agent:main:telegram:direct:42",
    });
    await retried("patch", { ...patch, reason: "renamed target" });
    await expect(retried("archive")).rejects.toThrow(/archive needs absorbed_into .* or a reason/);

    expect(consumeRunSkillUsage("review-run")).toEqual([]);
    // Changes credit the conversation the review learned from, not its internal session.
    expect(await listWorkshopChanges("main", { runId: "review-run" })).toMatchObject([
      {
        action: "patch",
        actor: "review",
        summary: "renamed target",
        sessionKey: "agent:main:telegram:direct:42",
      },
    ]);
  });

  it("gates remove_file behind a prior view in background runs", async () => {
    await workshop()("write_file", supportFile);
    const tool = workshop({ runId: "review-remove-run", reviewOf: "agent:main:main" });
    const remove = { file_path: supportFile.file_path };
    await expect(tool("remove_file", remove)).rejects.toThrow("View it first");
    // Reading an old saved version is not reading the live skill it would edit.
    const [entry] = await listWorkshopArchive({}, "main");
    await tool("view", { version: entry?.versions[0]?.id });
    await expect(tool("remove_file", remove)).rejects.toThrow("View it first");
    await tool("view");
    expect(await tool("remove_file", remove)).toContain('Updated "deploy"');
  });

  it("does not write once the invoking run is aborted", async () => {
    const aborted = AbortSignal.abort(new Error("run aborted"));
    await expect(workshop()("patch", patch, aborted)).rejects.toThrow("run aborted");
    expect(await listWorkshopChanges("main", {})).toHaveLength(1);
  });
  it("removes one support file as an undoable change and never removes SKILL.md", async () => {
    const tool = workshop({ runId: "fg-run" });
    await tool("write_file", supportFile);

    await expect(tool("remove_file", { file_path: "SKILL.md" })).rejects.toThrow(
      "SKILL.md cannot be removed. Archive the skill",
    );
    await expect(tool("remove_file", { file_path: "references/nope.md" })).rejects.toThrow(
      "references/nope.md does not exist",
    );

    await tool("remove_file", { file_path: supportFile.file_path });
    expect(await tool("view")).not.toContain("references/old.md");
    expect(consumeRunSkillUsage("fg-run")).toEqual([
      expect.objectContaining({ name: "deploy", source: "workspace", activation: "read" }),
    ]);

    await tool("restore");
    expect(await tool("view", { file_path: supportFile.file_path })).toContain("stale notes\n");
    expect((await listWorkshopChanges("main", { runId: "fg-run" })).map((c) => c.action)).toEqual([
      "restore",
      "remove_file",
      "write_file",
    ]);
  });
  it("saves a background review's change as a draft in propose mode and leaves skills unchanged", async () => {
    setRuntimeConfigSnapshot({ skills: { workshop: { autonomous: { mode: "propose" } } } });
    const review = workshop({ runId: "propose-run", reviewOf: "agent:main:main" });
    await review("view");
    await expect(review("patch", patch)).rejects.toThrow(
      "Learning is in propose mode; save this change with action=draft instead.",
    );
    const drafted = await review("draft", {
      content: "---\nname: deploy\ndescription: Deploy staging\n---\n\n1. Run make ship.\n",
      reason: "target was renamed",
    });
    const id = /Saved draft (\S+) for "deploy"/.exec(drafted)?.[1];
    expect(id).toBeDefined();
    await expect(review("discard", { draft: id })).rejects.toThrow(
      "Background reviews may not discard drafts.",
    );
    expect(await review("view")).toContain("1. Run make deploy.");
    expect(await listWorkshopChanges("main", { runId: "propose-run" })).toEqual([]);

    // A foreground /learn drafts turn finds, reads, and clears the draft.
    const foreground = workshop();
    expect(await foreground("list")).toContain(`- ${id} (deploy): target was renamed`);
    expect(await foreground("view", { draft: id })).toContain("1. Run make ship.");
    expect(await foreground("discard", { draft: id })).toBe(`Discarded draft ${id}.`);
    expect(await foreground("list")).not.toContain("Drafts waiting");
  });

  it("stops draft saves and discards whose run is aborted while they prepare", async () => {
    const content = "---\nname: deploy\ndescription: Deploy staging\n---\n\n1. Run make ship.\n";
    const draftsDir = resolveWorkshopDraftsDir({}, "main");
    const draftIds = async () =>
      (await fs.readdir(draftsDir).catch(() => [] as string[])).toSorted((a, b) =>
        a.localeCompare(b),
      );

    // The call captures the run's authority, then awaits; the abort lands before any file effect.
    const saving = new AbortController();
    const save = workshop()("draft", { content }, saving.signal);
    saving.abort(new Error("run aborted"));
    await expect(save).rejects.toThrow("run aborted");
    expect(await draftIds()).toEqual([]);

    const id = /Saved draft (\S+) for/.exec(await workshop()("draft", { content }))?.[1];
    const discarding = new AbortController();
    const discard = workshop()("discard", { draft: id }, discarding.signal);
    discarding.abort(new Error("run aborted"));
    await expect(discard).rejects.toThrow("run aborted");
    expect(await draftIds()).toEqual([id]);
  });

  it("shows the other learned skills on create so the agent can merge duplicates", async () => {
    const result = await workshop()("create", {
      name: "staging-deploy",
      content: "---\nname: staging-deploy\ndescription: Deploy to staging\n---\n\n1. Run it.\n",
    });
    expect(result).toContain('Created "staging-deploy"');
    expect(result).toContain("- deploy: Deploy staging");
    expect(result).not.toContain("- staging-deploy:");
  });
});
