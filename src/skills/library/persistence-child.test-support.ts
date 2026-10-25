import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import {
  PERSISTENCE_SESSION_ID,
  PERSISTENCE_SESSION_KEY,
  persistenceFiles,
  type PersistenceCommand,
  type PersistenceReply,
} from "./persistence.test-support.js";

async function send(
  message: PersistenceReply | { kind: "ready" | "booted" } | { kind: "error"; error: string },
) {
  await new Promise<void>((resolve, reject) => {
    assert.ok(typeof process.send === "function");
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

async function beginOperation() {
  // Install the gate before readiness; publication replies cannot satisfy this handshake.
  const start = hold();
  await send({ kind: "ready" });
  await start;
}

// The IPC listener keeps publishers alive without sleeps or production test flags.
const hold = () => once(process, "message");

async function runCandidate(command: PersistenceCommand, root: string): Promise<PersistenceReply> {
  const bundle = await import("./bundle.js");
  if (command.action === "stage-hold") {
    await beginOperation();
    const staged = await bundle.stageSkillLibraryBundle(
      command.pin.skillId,
      bundle.prepareSkillLibraryBundle(persistenceFiles(command.version)),
      process.env,
    );
    try {
      await send({ kind: "staged", directory: staged.staging });
      await hold();
    } finally {
      await staged.cleanup();
    }
    return { kind: "complete" };
  }
  const state = await import("../../state/openclaw-state-db.js");
  const { ensureProfileForEmail } = await import("../../state/user-profiles.js");
  const service = await import("./service.js");
  const usesSessions = ["seed", "read", "update-remove"].includes(command.action);
  const sessions = usesSessions
    ? await import("../../config/sessions/session-accessor.sqlite-entry.js")
    : undefined;
  const agent = usesSessions ? await import("../../state/openclaw-agent-db.js") : undefined;
  const selection = usesSessions ? await import("./selection.js") : undefined;
  const uploads = command.action === "seed" ? await import("./import.js") : undefined;
  await beginOperation();
  const options = { env: process.env, path: path.join(root, "state", "openclaw.sqlite") };
  const scope = { env: process.env, agentId: "main", sessionKey: PERSISTENCE_SESSION_KEY };
  try {
    const profile = ensureProfileForEmail("persistence@example.test", options);
    const authority = {
      profileId: profile.id,
      scopes: ["operator.admin"],
      getConfig: () => ({}),
      assertCurrent: () => {},
    };
    const save = (
      version: "old" | "new" | "orphan",
      slug: string,
      pin?: { skillId: string; revision: string },
    ) => {
      const [instructions, ...files] = persistenceFiles(version);
      return service.saveSkillLibrary(
        authority,
        {
          slug,
          content: instructions!.content,
          files,
          skillId: pin?.skillId,
          expectedRevision: pin?.revision ?? null,
        },
        options,
      );
    };
    const mutate = (skillId: string, revision: string, action: "transfer" | "remove") =>
      service.mutateSkillLibrary(
        authority,
        { skillId, expectedRevision: revision, action },
        options,
      );
    if (command.action === "seed") {
      assert.ok(sessions && selection && uploads);
      for (const ownership of ["personal", "team"]) {
        const result = await save("old", `persistence-${ownership}`);
        if (ownership === "team") {
          await mutate(result.entry.skillId, result.entry.revision, "transfer");
        }
      }
      const pins = await selection.seedSkillLibrarySelection(authority, options);
      sessions.replaceSessionEntrySync(scope, {
        sessionId: PERSISTENCE_SESSION_ID,
        updatedAt: Date.now(),
        skillLibrarySelections: pins,
      });
      const { uploadSkillLibrary } = uploads;
      const pendingBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
      const upload = await uploadSkillLibrary(
        authority,
        {
          action: "begin",
          slug: "unfinished-import",
          sizeBytes: pendingBytes.length,
          sha256: createHash("sha256").update(pendingBytes).digest("hex"),
        },
        options,
      );
      assert.ok("uploadId" in upload);
      await uploadSkillLibrary(
        authority,
        {
          action: "chunk",
          uploadId: upload.uploadId,
          offset: 0,
          data: pendingBytes.subarray(0, 2).toString("base64"),
        },
        options,
      );
      return { kind: "seeded" };
    }
    const pins = sessions?.loadSessionEntry(scope)?.skillLibrarySelections;
    if (command.action === "read") {
      assert.ok(pins && selection);
      const catalog = selection.loadSkillLibrarySelection(pins, options);
      return {
        kind: "selected",
        pins,
        files: await Promise.all(
          pins.map((pin) => selection.readSelectedSkillLibraryFiles(pin, options)),
        ),
        catalog: catalog.map((entry) => ({ name: entry.skill.name, baseDir: entry.skill.baseDir })),
        available: (await service.listSkillLibrary(authority, {}, options)).entries.map(
          (entry) => entry.skillId,
        ),
      };
    }
    if (command.action === "update-remove") {
      assert.ok(pins);
      for (const pin of pins) {
        const saved = await save("new", "renamed-procedure", pin);
        await mutate(pin.skillId, saved.entry.revision, "remove");
      }
      return { kind: "complete" };
    }
    const originalOpen = fs.open;
    const originalRename = fs.rename;
    let renamedDestination: string | undefined;
    if (command.action === "publish-hold") {
      const expectedDestination = bundle.skillLibraryRevisionDir(
        command.pin.skillId,
        bundle.prepareSkillLibraryBundle(persistenceFiles(command.version)).revision,
        process.env,
      );
      fs.rename = async (source, destination) => {
        await originalRename(source, destination);
        if (destination === expectedDestination) {
          renamedDestination = expectedDestination;
        }
      };
      fs.open = async (...args) => {
        const handle = await originalOpen(...args);
        if (renamedDestination && args[0] === root && args[1] === "r") {
          const originalClose = handle.close.bind(handle);
          handle.close = async () => {
            handle.close = originalClose;
            await originalClose();
            // The real rename, file syncs, and final ancestor-directory sync/close
            // have completed. Holding here keeps the service before its DB commit.
            await send({ kind: "published", directory: renamedDestination! });
            await hold();
          };
        }
        return handle;
      };
    }
    try {
      await save(command.version, "revised-procedure", command.pin);
    } finally {
      fs.open = originalOpen;
      fs.rename = originalRename;
    }
    return { kind: "complete" };
  } finally {
    await agent?.closeOpenClawAgentDatabasesAsync();
    await state.closeOpenClawStateDatabaseAsync();
  }
}

async function handleCommand(command: PersistenceCommand) {
  try {
    const root = process.env.OPENCLAW_STATE_DIR;
    assert.ok(root);
    await send(await runCandidate(command, root));
  } catch (error) {
    process.exitCode = 1;
    await send({
      kind: "error",
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  } finally {
    assert.ok(typeof process.disconnect === "function");
    process.disconnect();
  }
}
process.once("message", (command: PersistenceCommand) => {
  void handleCommand(command);
});
await send({ kind: "booted" });
