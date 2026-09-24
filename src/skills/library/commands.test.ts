import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { skillLibraryRevisionDir } from "./bundle.js";
import { loadSkillLibrarySelection, seedSkillLibrarySelection } from "./selection.js";
import { mutateSkillLibrary, saveSkillLibrary } from "./service.js";
import { content, draft, createSkillLibraryFixture } from "./service.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
const fixture = () => createSkillLibraryFixture(tempDirs.make("skill-library-commands-"));

describe("pinned library skill commands", () => {
  it.each([
    ["heading", "# Friendly Title", "Friendly Title"],
    ["metadata fallback", "Plain introduction", "Guide"],
  ])(
    "keeps the %s separate from the selected command identity",
    async (_label, heading, displayName) => {
      const { options, alice, stateDir } = fixture();
      await saveSkillLibrary(
        alice,
        { ...draft("long---skill---name"), content: content.replace("# Guide", heading) },
        options,
      );
      const pins = seedSkillLibrarySelection(alice, options);
      const entries = loadSkillLibrarySelection(pins, options);
      const { buildSkillSnapshot } = await import("../loading/workspace-skill-prompt.js");
      const { buildWorkspaceSkillCommandSpecs } = await import("../discovery/command-specs.js");
      const snapshot = await buildSkillSnapshot(stateDir, { entries });
      const commands = buildWorkspaceSkillCommandSpecs(stateDir, { entries });
      expect(pins[0]!.name).toMatch(/^s_long_skil_[a-f0-9]{20}$/);
      expect(commands[0]).toMatchObject({
        name: "guide",
        aliases: [pins[0]!.name],
        skillName: pins[0]!.name,
        displayName,
      });
      expect(snapshot.prompt).toContain(`<name>${pins[0]!.name}</name>`);
      const copied = {
        ...entries[0]!,
        skill: { ...entries[0]!.skill, source: "openclaw-workspace" },
      };
      await expect(buildSkillSnapshot(stateDir, { entries: [copied, ...entries] })).rejects.toThrow(
        "ambiguous",
      );
      expect(() =>
        buildWorkspaceSkillCommandSpecs(stateDir, { entries: [copied, ...entries] }),
      ).toThrow("ambiguous");
    },
  );
  it("discovers pinned commands through the loader without leaking them into workspace state", async () => {
    const { alice, options, stateDir } = fixture();
    const saved = await saveSkillLibrary(alice, draft(), options);
    const pins = seedSkillLibrarySelection(alice, options);
    const updated = await saveSkillLibrary(
      alice,
      {
        ...draft(),
        skillId: saved.entry.skillId,
        expectedRevision: saved.entry.revision,
        content: `${content}\nUpdated`,
      },
      options,
    );
    const originalPin = expectDefined(pins[0], "original selected revision");
    const mixedRevisions = [
      { ...originalPin, revision: updated.entry.revision },
      originalPin,
      originalPin,
    ];
    expect(
      loadSkillLibrarySelection(mixedRevisions, options).map((entry) => entry.skill.filePath),
    ).toEqual(
      mixedRevisions.map((pin) =>
        path.join(skillLibraryRevisionDir(pin.skillId, pin.revision, options.env), "SKILL.md"),
      ),
    );
    expect(() =>
      loadSkillLibrarySelection(
        [originalPin, { ...originalPin, revision: "0".repeat(64) }],
        options,
      ),
    ).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    const {
      listSkillCommandsForWorkspace,
      listSkillCommandsForAgents,
      prepareSkillCommandsForAgents,
    } = await import("../discovery/chat-commands.js");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const cfg = { agents: { defaults: { skills: [] } } };
      const discover = (
        overrides: Partial<Parameters<typeof listSkillCommandsForWorkspace>[0]> = {},
      ) =>
        listSkillCommandsForWorkspace({
          workspaceDir: stateDir,
          cfg,
          agentId: "main",
          sessionEntry: { skillLibrarySelections: pins },
          ...overrides,
        });
      const commands = discover({ skillFilter: [saved.entry.name] });
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        name: "guide",
        skillName: saved.entry.name,
        skillFile: expect.stringContaining(saved.entry.revision),
      });
      expect(discover()).toEqual([]);
      expect(discover({ includeAllowlistHidden: true })).toContainEqual(commands[0]);
      expect(
        discover({
          includeAllowlistHidden: true,
          cfg: { ...cfg, skills: { entries: { [saved.entry.name]: { enabled: false } } } },
        }).map((entry) => entry.name),
      ).not.toContain(saved.entry.name);
      expect(discover({ sessionEntry: undefined, skillFilter: [saved.entry.name] })).toEqual([]);
      const agentParams = {
        cfg: {
          agents: {
            defaults: { skills: [saved.entry.name] },
            list: [{ id: "main", workspace: stateDir }],
          },
        },
        agentIds: ["main"],
        sessionEntry: { skillLibrarySelections: pins },
      };
      expect(listSkillCommandsForAgents(agentParams)).toEqual(commands);
      expect(await prepareSkillCommandsForAgents(agentParams)).toEqual(commands);
      expect(
        await prepareSkillCommandsForAgents({ ...agentParams, sessionEntry: undefined }),
      ).toEqual([]);
    });
  });

  it("invokes short pinned names without admitting another owner's private skill or a newer revision", async () => {
    const { options, alice, actor, stateDir } = fixture();
    const bob = actor(ensureProfileForEmail("bob@example.test", options).id);
    const instructions = content.replace("name: guide", "name: vac");
    const saved = await saveSkillLibrary(
      alice,
      { ...draft("review-helper"), content: instructions },
      options,
    );
    await saveSkillLibrary(bob, { ...draft("private-helper"), content: instructions }, options);
    const pins = seedSkillLibrarySelection(alice, options);
    await saveSkillLibrary(
      alice,
      {
        ...draft("renamed-helper"),
        skillId: saved.entry.skillId,
        expectedRevision: saved.entry.revision,
        content: instructions.replace("name: vac", "name: changed"),
      },
      options,
    );
    const { buildWorkspaceSkillCommandSpecs } = await import("../discovery/command-specs.js");
    const { resolveSkillCommandInvocation, expandExplicitSkillReferences } =
      await import("../discovery/chat-command-invocation.js");
    const { listChatCommands } = await import("../../auto-reply/commands-registry-list.js");
    const commands = buildWorkspaceSkillCommandSpecs(stateDir, {
      entries: loadSkillLibrarySelection(pins, options),
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      name: "vac",
      skillName: saved.entry.name,
      skillFile: expect.stringContaining(saved.entry.revision),
    });
    for (const command of [
      "/vac",
      "/skill vac",
      "/" + saved.entry.name,
      "/skill " + saved.entry.name,
    ]) {
      expect(
        resolveSkillCommandInvocation({
          commandBodyNormalized: command + " #123",
          skillCommands: commands,
        }),
      ).toEqual({ command: commands[0], args: "#123" });
    }
    expect(
      expandExplicitSkillReferences({ text: "$vac #123", skillCommands: commands }).skills,
    ).toEqual(commands);
    expect(
      listChatCommands({ skillCommands: commands }).find(
        (command) => command.key === "skill:" + saved.entry.name,
      ),
    ).toMatchObject({ nativeName: "vac", textAliases: ["/vac", "/" + saved.entry.name] });
  });

  it("keeps ambiguous, reserved and normalized-colliding short names on stable identities", async () => {
    const { options, alice, actor, stateDir } = fixture();
    const bob = actor(ensureProfileForEmail("bob@example.test", options).id);
    const first = await saveSkillLibrary(
      alice,
      { ...draft("first"), content: content.replace("name: guide", "name: review-notes") },
      options,
    );
    const second = await saveSkillLibrary(
      bob,
      { ...draft("second"), content: content.replace("name: guide", "name: review_notes") },
      options,
    );
    mutateSkillLibrary(
      bob,
      { skillId: second.entry.skillId, expectedRevision: second.entry.revision, action: "share" },
      options,
    );
    const entries = loadSkillLibrarySelection(seedSkillLibrarySelection(alice, options), options);
    const { buildWorkspaceSkillCommandSpecs } = await import("../discovery/command-specs.js");
    const { resolveSkillCommandInvocation } =
      await import("../discovery/chat-command-invocation.js");
    for (const ordered of [entries, entries.toReversed()]) {
      const commands = buildWorkspaceSkillCommandSpecs(stateDir, { entries: ordered });
      expect(new Set(commands.map((command) => command.name))).toEqual(
        new Set([first.entry.name, second.entry.name]),
      );
      expect(
        resolveSkillCommandInvocation({
          commandBodyNormalized: "/review_notes #123",
          skillCommands: commands,
        }),
      ).toBeNull();
    }
    const entry = entries.find((candidate) => candidate.skill.name === first.entry.name)!;
    const reserved = buildWorkspaceSkillCommandSpecs(stateDir, {
      entries: [entry],
      reservedNames: new Set(["review_notes"]),
    });
    expect(reserved[0]?.name).toBe(first.entry.name);
    const workspace = {
      ...entry,
      skill: { ...entry.skill, name: "review-notes", source: "openclaw-workspace" },
    };
    for (const ordered of [
      [entry, workspace],
      [workspace, entry],
    ]) {
      expect(
        buildWorkspaceSkillCommandSpecs(stateDir, { entries: ordered }).find(
          (command) => command.skillName === first.entry.name,
        )?.name,
      ).toBe(first.entry.name);
    }
    const long = { ...entry, frontmatter: { ...entry.frontmatter, name: "x".repeat(80) } };
    expect(buildWorkspaceSkillCommandSpecs(stateDir, { entries: [long] })[0]?.name).toBe(
      "x".repeat(32),
    );
  });
});
