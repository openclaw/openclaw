import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  SkillLibraryFile,
  SkillLibrarySelection,
} from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { createBoundedChildOutput } from "../../../test/helpers/bounded-child-output.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { persistenceRuntimeEntrypoint } from "./persistence-runtime.test-support.js";

export const PERSISTENCE_SESSION_KEY = "agent:main:library-persistence";
export const PERSISTENCE_SESSION_ID = "library-persistence-session";
const bytesOf = (file: SkillLibraryFile) => Buffer.from(file.content, file.encoding ?? "utf8");
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const byPath = (a: SkillLibraryFile, b: SkillLibraryFile) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

export function persistenceFiles(version: "old" | "new" | "orphan"): SkillLibraryFile[] {
  return [
    {
      path: "SKILL.md",
      content: `---\nname: persistence\ndescription: Durable ${version} procedure\n---\n# Procedure\nRead references/data.bin and run scripts/task.sh.\n${version}\n`,
    },
    {
      path: "references/data.bin",
      content: Buffer.from([0, 255, 128, ...Buffer.from(version)]).toString("base64"),
      encoding: "base64",
    },
    {
      path: "scripts/task.sh",
      content: `#!/bin/sh\nprintf '%s\\n' '${version}'\n`,
      executable: true,
    },
    { path: "references/empty.txt", content: "" },
  ];
}

function persistenceEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      ["HOME", "USERPROFILE", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "TMPDIR", "TMP", "TEMP"].map(
        (key) => [key, root],
      ),
    ),
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    OPENCLAW_AGENT_DIR: path.join(root, "agents", "main", "agent"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    NODE_ENV: "test",
  };
}

export type PersistenceCommand =
  | { action: "seed" }
  | { action: "read" }
  | { action: "update-remove" }
  | {
      action: "publish-hold" | "stage-hold" | "save";
      pin: SkillLibrarySelection;
      version: "new" | "orphan";
    };

export type PersistenceReply =
  | { kind: "seeded" }
  | { kind: "complete" }
  | { kind: "staged" | "published"; directory: string }
  | {
      kind: "selected";
      pins: SkillLibrarySelection[];
      files: SkillLibraryFile[][];
      catalog: Array<{ name: string; baseDir: string }>;
      available: string[];
    };

/** IPC owns readiness; close is installed before any signal, and every child is reaped in finally. */
export async function withPersistenceChild(
  root: string,
  command: PersistenceCommand,
  signal: AbortSignal,
  use?: (
    reply: PersistenceReply,
    child: { pid: number; kill: () => Promise<void> },
  ) => Promise<void>,
): Promise<PersistenceReply> {
  const output = createBoundedChildOutput();
  const diagnostic = () => `${command.action}: ${output.text()}`;
  const wait = <T>(work: PromiseLike<T>) => withinTest(work, signal);
  const workerUrl = resolveRuntimeWorkerUrl(persistenceRuntimeEntrypoint);
  const child = fork(workerUrl, [], {
    execArgv: workerUrl.pathname.endsWith(".ts")
      ? ["--import", new URL("../../../scripts/tsx.mjs", import.meta.url).href]
      : [],
    env: persistenceEnvironment(root),
    cwd: path.resolve(import.meta.dirname, "../../.."),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout?.on("data", output.append);
  child.stderr?.on("data", output.append);
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, exitSignal) => resolve({ code, signal: exitSignal }));
  });
  const moduleReady = createDeferred();
  try {
    const replyPromise = new Promise<PersistenceReply>((resolve, reject) => {
      const fail = (message: string) => reject(new Error(`${diagnostic()}; ${message}`));
      const send = (message: PersistenceCommand | { kind: "run" }) => {
        child.send(message, (error) => {
          if (error) {
            reject(error);
          }
        });
      };
      child.once("error", reject);
      child.on("message", (message: { kind?: string; error?: string }) => {
        if (message.kind === "booted") {
          send(command);
        } else if (message.kind === "ready") {
          moduleReady.resolve();
          send({ kind: "run" });
        } else if (message.kind === "error") {
          fail(message.error ?? "Unknown child error");
        } else {
          resolve(message as PersistenceReply);
        }
      });
      void closed.then((exit) => fail(`Child exited before reply (${exit.signal ?? exit.code})`));
    });
    await wait(
      awaitGateBeforeSettlement(
        moduleReady.promise,
        replyPromise,
        "Persistence child did not become module-ready",
      ),
    );
    const reply = await wait(replyPromise);
    assert.ok(child.pid);
    if (use) {
      await use(reply, {
        pid: child.pid,
        async kill() {
          assert.equal(child.kill("SIGKILL"), true);
          assert.deepEqual(await wait(closed), { code: null, signal: "SIGKILL" });
        },
      });
    } else {
      assert.deepEqual(await wait(closed), { code: 0, signal: null }, output.text());
    }
    return reply;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await closed;
    process.stderr.write(`[persistence-child] ${diagnostic()}\n`);
  }
}

export function readPersistenceDisk(root: string) {
  using state = new DatabaseSync(path.join(root, "state", "openclaw.sqlite"), { readOnly: true });
  using agent = new DatabaseSync(
    path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"),
    { readOnly: true },
  );
  const row = agent
    .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
    .get(PERSISTENCE_SESSION_KEY);
  assert.equal(typeof row?.entry_json, "string");
  const session = JSON.parse(row!.entry_json as string) as {
    skillLibrarySelections: SkillLibrarySelection[];
    label?: string;
  };
  const rows = (table: string, order: string) =>
    state.prepare(`SELECT * FROM skill_library_${table} ORDER BY ${order}`).all();
  return {
    stateVersion: state.prepare("PRAGMA user_version").get()!.user_version,
    agentVersion: agent.prepare("PRAGMA user_version").get()!.user_version,
    entries: rows("entries", "skill_id"),
    revisions: rows("revisions", "skill_id, revision"),
    events: rows("events", "event_id"),
    uploads: rows("uploads", "upload_id"),
    pins: session.skillLibrarySelections,
    label: session.label,
  };
}

export function persistenceRevisionDir(
  root: string,
  pin: Pick<SkillLibrarySelection, "skillId" | "revision">,
) {
  return path.join(root, "skill-library", pin.skillId, "revisions", pin.revision);
}

/** Independent bytes/manifest oracle: never asks the service to verify its own write. */
export async function assertPersistenceBundle(
  root: string,
  pin: SkillLibrarySelection,
  version: "old" | "new" | "orphan",
  recorded = true,
) {
  const manifest = persistenceFiles(version)
    .toSorted(byPath)
    .map((file) => {
      const bytes = bytesOf(file);
      return {
        path: file.path,
        sha256: hash(bytes),
        sizeBytes: bytes.length,
        executable: file.executable === true,
      };
    });
  assert.equal(hash(JSON.stringify(["openclaw.skill-library.tree.v1", manifest])), pin.revision);
  if (recorded) {
    const row = readPersistenceDisk(root).revisions.find(
      (item) => item.skill_id === pin.skillId && item.revision === pin.revision,
    );
    assert.ok(row);
    assert.equal(row.files_json, JSON.stringify(manifest));
  }
  await assertPersistenceFiles(persistenceRevisionDir(root, pin), version);
}

export async function assertPersistenceFiles(directory: string, version: "old" | "new" | "orphan") {
  const files = persistenceFiles(version);
  const actualFiles = (await fs.readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => !entry.isDirectory())
    .map((entry) =>
      path.relative(directory, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"),
    );
  assert.deepEqual(actualFiles.toSorted(), files.map((file) => file.path).toSorted());
  for (const file of files) {
    const filename = path.join(directory, file.path);
    const stat = await fs.lstat(filename);
    assert.equal(stat.isFile(), true);
    assert.deepEqual(await fs.readFile(filename), bytesOf(file));
    if (process.platform !== "win32") {
      assert.equal((stat.mode & 0o111) !== 0, file.executable === true);
    }
  }
}

export function assertPersistenceSelection(
  root: string,
  reply: PersistenceReply,
  pins: SkillLibrarySelection[],
) {
  assert.equal(reply.kind, "selected", "Expected reopened selection");
  const artifacts = (files: SkillLibraryFile[]) =>
    files.map((file) => ({
      path: file.path,
      bytes: bytesOf(file),
      executable: file.executable === true,
    }));
  const files = artifacts(persistenceFiles("old").toSorted(byPath));
  assert.deepEqual(
    [reply.pins, reply.catalog, reply.files.map(artifacts)],
    [
      pins,
      pins.map((pin) => ({ name: pin.name, baseDir: persistenceRevisionDir(root, pin) })),
      pins.map(() => files),
    ],
  );
}
