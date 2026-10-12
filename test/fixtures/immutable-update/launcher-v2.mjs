#!/usr/bin/env node
// Adoption pins the external Node path in this shebang; this launcher never updates current.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const recordObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (file) => {
  const stat = fs.lstatSync(file, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
};

function admitActivation(root, generation) {
  const key = createHash("sha256").update(root).digest("hex").slice(0, 24);
  const control = path.join(path.dirname(root), `.openclaw.package-activation-${key}.control`);
  const journal = path.join(control, "operation.sqlite");
  const directory = fs.lstatSync(control, { bigint: true, throwIfNoEntry: false });
  if (!directory) {
    return;
  }
  const file = fs.lstatSync(journal, { bigint: true, throwIfNoEntry: false });
  if (
    !directory.isDirectory() ||
    directory.uid !== 0n ||
    (directory.mode & 0o022n) !== 0n ||
    fs.realpathSync(control) !== control ||
    !file?.isFile() ||
    file.uid !== 0n ||
    file.nlink !== 1n ||
    (file.mode & 0o022n) !== 0n ||
    fs.realpathSync(journal) !== journal
  ) {
    throw new Error("immutable activation control has unsafe ownership or identity");
  }
  if (
    ["-wal", "-shm"].some((suffix) => fs.lstatSync(journal + suffix, { throwIfNoEntry: false }))
  ) {
    throw new Error("immutable activation control requires rollback-journal recovery");
  }
  // Boot admission never replays a hot journal or creates a control database.
  const db = new DatabaseSync(journal, { readOnly: true });
  const readAdmission = () => {
    db.exec("BEGIN");
    const mode = db.prepare("PRAGMA journal_mode").get()?.journal_mode;
    if (!["delete", "truncate", "persist"].includes(mode)) {
      throw new Error("immutable activation control requires rollback journal mode");
    }
    const rows = db
      .prepare(
        "SELECT slot, CASE WHEN length(CAST(descriptor_json AS BLOB)) <= 1048576 THEN descriptor_json END AS descriptor_json FROM immutable_installation LIMIT 2",
      )
      .all();
    if (rows.length !== 1 || rows[0].slot !== 1 || typeof rows[0].descriptor_json !== "string") {
      throw new Error("immutable activation control must contain one valid descriptor");
    }
    const descriptor = JSON.parse(rows[0].descriptor_json);
    if (
      !recordObject(descriptor) ||
      descriptor.kind !== "immutable" ||
      descriptor.root !== root ||
      descriptor.rootIdentity !== identity(root)
    ) {
      throw new Error("immutable activation control belongs to another installation");
    }
    if (descriptor.version === 1 && descriptor.activationEnabled === undefined) {
      return;
    }
    if (
      descriptor.version !== 2 ||
      descriptor.activationEnabled !== true ||
      !recordObject(descriptor.current) ||
      !/^[a-f0-9]{40}$/.test(descriptor.current.sha ?? "") ||
      descriptor.current.path !== path.join(root, "releases", descriptor.current.sha) ||
      descriptor.current.path !== generation ||
      descriptor.current.identity !== identity(generation) ||
      descriptor.current.pointerIdentity !== identity(path.join(root, "current")) ||
      !recordObject(descriptor.runtime) ||
      descriptor.runtime.path !== fs.realpathSync(process.execPath)
    ) {
      throw new Error(
        "immutable activation descriptor does not authorize this physical generation",
      );
    }
    const row = db
      .prepare(
        "SELECT CASE WHEN length(CAST(activation_json AS BLOB)) <= 1048576 THEN activation_json END AS activation_json FROM immutable_installation WHERE slot = 1",
      )
      .get();
    if (typeof row?.activation_json !== "string") {
      throw new Error("immutable activation state is missing or invalid");
    }
    const activation = JSON.parse(row.activation_json);
    if (activation === null) {
      return;
    }
    if (
      !recordObject(activation) ||
      Object.keys(activation).some(
        (name) => !["operation", "previous", "lastResult"].includes(name),
      )
    ) {
      throw new Error("immutable activation state is malformed");
    }
    const operation = activation.operation;
    if (operation === undefined) {
      if (
        (activation.previous !== undefined && !recordObject(activation.previous)) ||
        (activation.lastResult !== undefined &&
          (!recordObject(activation.lastResult) ||
            !["succeeded", "rolled-back"].includes(activation.lastResult.outcome) ||
            activation.lastResult.selectedSha !== descriptor.current.sha))
      ) {
        throw new Error("immutable completed activation state is malformed");
      }
      return;
    }
    if (
      !recordObject(operation) ||
      operation.version !== 1 ||
      typeof operation.operationId !== "string" ||
      !operation.operationId ||
      !recordObject(operation.authority) ||
      operation.authority.installKey !== root ||
      !recordObject(operation.previous) ||
      !recordObject(operation.candidate)
    ) {
      throw new Error("immutable activation operation is malformed");
    }
    if (
      ![
        "prepared",
        "draining",
        "starting",
        "verifying",
        "rollback-starting",
        "rolled-back",
      ].includes(operation.phase)
    ) {
      throw new Error(
        `immutable activation blocks Gateway startup in phase ${String(operation.phase)}`,
      );
    }
    const selected = ["starting", "verifying"].includes(operation.phase)
      ? operation.candidate
      : operation.previous;
    if (
      selected.sha !== descriptor.current.sha ||
      selected.path !== generation ||
      selected.identity !== descriptor.current.identity
    ) {
      throw new Error("immutable activation phase does not authorize the selected generation");
    }
  };
  try {
    readAdmission();
  } finally {
    db.close();
  }
  if (
    identity(journal) !== `${file.dev}:${file.ino}` ||
    identity(control) !== `${directory.dev}:${directory.ino}`
  ) {
    throw new Error("immutable activation control changed during boot admission");
  }
}

try {
  const launcher = fileURLToPath(import.meta.url);
  const root = path.dirname(path.dirname(launcher));
  const releases = path.join(root, "releases");
  const pointer = path.join(root, "current");
  const generation = fs.realpathSync(pointer);
  if (path.dirname(generation) !== releases || !/^[a-f0-9]{40}$/u.test(path.basename(generation))) {
    throw new Error("current must select a direct releases/<full-sha> generation");
  }
  for (const directory of [root, path.dirname(launcher), releases, generation]) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
      throw new Error(`unsafe immutable installation directory: ${directory}`);
    }
  }
  const current = fs.lstatSync(pointer);
  if (!current.isSymbolicLink() || current.uid !== 0) {
    throw new Error("current must be an updater-owned symlink");
  }
  const entry = path.join(generation, "dist", "index.js");
  const stat = fs.lstatSync(entry);
  if (
    !stat.isFile() ||
    stat.uid !== 0 ||
    (stat.mode & 0o222) !== 0 ||
    fs.realpathSync(entry) !== entry
  ) {
    throw new Error("the Gateway entrypoint must be a sealed regular file");
  }
  if (typeof process.execve !== "function") {
    throw new Error("the pinned Node executable does not support execve");
  }
  admitActivation(root, generation);
  // Both cwd and argv use the selected physical tree, including subsequent lazy imports.
  process.chdir(generation);
  process.execve(
    process.execPath,
    [process.execPath, entry, "gateway", ...process.argv.slice(2)],
    process.env,
  );
} catch (error) {
  console.error(
    `Cannot start immutable OpenClaw Gateway: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 78;
}
