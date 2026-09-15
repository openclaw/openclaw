import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as stateReads from "../../state/openclaw-state-db-readonly.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { materializeSkill } from "../loading/skill-materializer.js";
import { prepareSkillResourceDelivery } from "../runtime/resources.js";
import type { SkillSnapshot } from "../types.js";
import * as bundles from "./bundle.js";
import { decodeSkillLibraryFile } from "./bundle.js";
import * as selectionReads from "./selection-read.js";
import * as selection from "./selection.js";
import { loadSkillLibrarySelection } from "./selection.js";
import { saveSkillLibrary } from "./service.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
const content =
  "---\nname: guide\ndescription: Saved procedure\n---\n# Guide\nRead references/data.bin.\n";

async function fixture() {
  const root = dirs.make("skill-library-resource-read-");
  const options = { env: { OPENCLAW_STATE_DIR: root } };
  const profile = ensureProfileForEmail("reader@example.test", options);
  const authority = {
    profileId: profile.id,
    scopes: ["operator.read", "operator.write"],
    getConfig: () => ({}),
    assertCurrent() {},
  };
  const saved = await saveSkillLibrary(
    authority,
    {
      slug: "guide",
      content,
      expectedRevision: null,
      files: [{ path: "references/data.bin", content: "AP+A", encoding: "base64" }],
    },
    options,
  );
  const pin = {
    skillId: saved.entry.skillId,
    revision: saved.entry.revision,
    name: saved.entry.name,
    ownerProfileId: saved.entry.ownerProfileId,
  };
  const snapshot: SkillSnapshot = {
    prompt: "",
    skills: [{ name: pin.name }],
    librarySelections: [pin],
  };
  const databasePath = openOpenClawStateDatabase(options).path;
  await closeOpenClawStateDatabaseAsync();
  return { root, options, authority, pin, snapshot, databasePath };
}

function observeParentSqlite() {
  const native = requireNodeSqlite();
  return [
    vi.spyOn(native.DatabaseSync.prototype, "prepare"),
    vi.spyOn(native.DatabaseSync.prototype, "exec"),
    ...(["get", "all", "run", "iterate"] as const).map((method) =>
      vi.spyOn(native.StatementSync.prototype, method),
    ),
  ];
}

function familyHashes(databasePath: string) {
  return ["", "-wal", "-shm", "-journal"].map((suffix) => {
    const file = `${databasePath}${suffix}`;
    return fs.existsSync(file)
      ? [suffix, createHash("sha256").update(fs.readFileSync(file)).digest("hex")]
      : [suffix, null];
  });
}

it.each(["ordinary", "artifact-preserving", "disposable"] as const)(
  "delivers cold and warm immutable pins without parent SQL under %s reads",
  async (mode) => {
    const { root, snapshot, pin, databasePath } = await fixture();
    const before = familyHashes(databasePath);
    const execute = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
    const counters = observeParentSqlite();
    const run = () =>
      withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
        const first = await prepareSkillResourceDelivery(snapshot, () => {});
        expect(first?.skills).toHaveLength(1);
        const skill = first!.skills[0]!;
        expect(skill.revision).toBe(pin.revision);
        expect(
          decodeSkillLibraryFile(skill.files.find((file) => file.path === "SKILL.md")!).toString(
            "utf8",
          ),
        ).toBe(content);
        expect(
          decodeSkillLibraryFile(skill.files.find((file) => file.path === "references/data.bin")!),
        ).toEqual(Buffer.from([0, 255, 128]));
        // The synchronous caller must reuse the same cache key as async preparation.
        expect(loadSkillLibrarySelection([pin])[0]?.skill.name).toBe(pin.name);
        expect(await prepareSkillResourceDelivery(structuredClone(snapshot), () => {})).toEqual(
          first,
        );
        await closeOpenClawStateDatabaseAsync();
      });
    try {
      if (mode === "artifact-preserving") {
        await stateReads.withArtifactPreservingStateReads(run);
      } else if (mode === "disposable") {
        await stateReads.withArtifactPreservingStateReads(() =>
          stateReads.withDisposableOpenClawStateReads(databasePath, run),
        );
      } else {
        await run();
      }
      expect(counters.map((counter) => counter.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
      expect(execute.mock.calls.map(([, command]) => command.type)).toEqual([
        "skills.library.descriptions",
        "skills.library.manifests",
        "skills.library.manifests",
      ]);
      if (mode === "artifact-preserving") {
        expect(familyHashes(databasePath)).toEqual(before);
      }
    } finally {
      for (const counter of counters) {
        counter.mockRestore();
      }
    }
  },
);

it("reads both phases from the active snapshot without fetching hidden manifests", async () => {
  const { root, options, authority, pin, snapshot } = await fixture();
  const hidden = await saveSkillLibrary(
    authority,
    {
      slug: "hidden",
      content: content.replace("guide", "hidden"),
      expectedRevision: null,
    },
    options,
  );
  snapshot.librarySelections!.push({
    skillId: hidden.entry.skillId,
    revision: hidden.entry.revision,
    name: hidden.entry.name,
    ownerProfileId: hidden.entry.ownerProfileId,
  });
  await closeOpenClawStateDatabaseAsync();
  const execute = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
  await withEnvAsync({ OPENCLAW_STATE_DIR: root }, () =>
    stateReads.withOpenClawStateDatabaseReadSnapshot(async () => {
      const database = openOpenClawStateDatabase(options);
      database.db
        .prepare(
          "UPDATE skill_library_revisions SET description = ?, files_json = ? WHERE skill_id = ?",
        )
        .run("Later live description", "invalid live manifest", pin.skillId);
      const delivery = await prepareSkillResourceDelivery(snapshot, () => {});
      expect(delivery?.skills).toHaveLength(1);
      expect(delivery?.skills[0]?.description).toBe("Saved procedure");
      expect(delivery?.skills[0]?.revision).toBe(pin.revision);
      const manifests = execute.mock.calls
        .map(([, command]) => command)
        .find((command) => command.type === "skills.library.manifests");
      expect(manifests?.input).toEqual([{ skillId: pin.skillId, revision: pin.revision }]);
    }, options),
  );
});

it.each(["root", "authority"] as const)(
  "retains the captured owner when %s changes while descriptions are pending",
  async (change) => {
    const { root, snapshot } = await fixture();
    const other = dirs.make("skill-library-other-root-");
    const entered = createDeferredCore();
    const gate = createDeferredCore();
    const original = selectionReads.readSkillLibrarySelectionDescriptions;
    vi.spyOn(selectionReads, "readSkillLibrarySelectionDescriptions").mockImplementation(
      async (...args) => {
        const descriptions = await original(...args);
        entered.resolve();
        await gate.promise;
        return descriptions;
      },
    );
    const closed = new Error("Synthetic resource owner closed");
    let current = true;
    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      const pending = prepareSkillResourceDelivery(snapshot, () => {
        if (!current) {
          throw closed;
        }
      });
      const outcome = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await entered.promise;
      if (change === "root") {
        process.env.OPENCLAW_STATE_DIR = other;
      } else {
        current = false;
      }
      gate.resolve();
      const result = await outcome;
      if (change === "authority") {
        expect(result).toEqual({ error: closed });
      } else {
        expect(result).toMatchObject({ value: { skills: [{ description: "Saved procedure" }] } });
        expect(fs.existsSync(path.join(other, "state", "openclaw.sqlite"))).toBe(false);
      }
    });
  },
);

it.each(["file", "table"] as const)(
  "does not create missing library %s storage",
  async (missing) => {
    const root = dirs.make("skill-library-missing-read-");
    const options = { env: { OPENCLAW_STATE_DIR: root } };
    if (missing === "table") {
      openOpenClawStateDatabase(options);
      await closeOpenClawStateDatabaseAsync();
    }
    const snapshot: SkillSnapshot = {
      prompt: "",
      skills: [{ name: "missing" }],
      librarySelections: [
        { skillId: "missing", revision: "0".repeat(64), name: "missing", ownerProfileId: null },
      ],
    };
    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      await expect(prepareSkillResourceDelivery(snapshot, () => {})).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });
    if (missing === "file") {
      expect(fs.existsSync(path.join(root, "state", "openclaw.sqlite"))).toBe(false);
    } else {
      expect(tableExists(openOpenClawStateDatabase(options).db, "skill_library_entries")).toBe(
        false,
      );
    }
  },
);

it.each(["workspace", "library"] as const)(
  "preserves the first %s failure and resource context before reading later candidates",
  async (first) => {
    const root = dirs.make("skill-library-read-order-");
    const skills = ["workspace", "library"].map((name) =>
      materializeSkill({
        name,
        description: name,
        content,
        frontmatter: {},
        filePath: path.join(root, name, "SKILL.md"),
        baseDir: path.join(root, name),
        source: "openclaw-workspace",
        sourceOptions: { source: "openclaw-workspace" },
      }),
    );
    const [workspace, library] = skills;
    const snapshot: SkillSnapshot = {
      prompt: "",
      skills: skills.map(({ name }) => ({ name })),
      resolvedSkills: first === "workspace" ? skills : [library!, workspace!],
      librarySelections: [
        { skillId: "library", revision: "0".repeat(64), name: "library", ownerProfileId: null },
      ],
    };
    const workspaceError = new Error("Synthetic workspace read failed");
    const libraryError = new Error("Synthetic database read failed");
    vi.spyOn(selection, "prepareSkillLibrarySelection").mockResolvedValue([]);
    const readWorkspace = vi
      .spyOn(bundles, "readSkillBundleTree")
      .mockRejectedValue(workspaceError);
    const readManifests = vi
      .spyOn(selectionReads, "readSkillLibrarySelectionManifests")
      .mockRejectedValue(libraryError);
    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      await expect(prepareSkillResourceDelivery(snapshot, () => {})).rejects.toMatchObject({
        code: "INVALID_BUNDLE",
        message: expect.stringContaining(`skill="${first}"`),
        cause: first === "workspace" ? workspaceError : libraryError,
      });
    });
    expect(readWorkspace).toHaveBeenCalledTimes(first === "workspace" ? 1 : 0);
    expect(readManifests).toHaveBeenCalledTimes(first === "library" ? 1 : 0);
  },
);
