// Shared verbatim by both launcher formats during the PR1 cutover. Only Node built-ins.
export const ROLLBACK_SOURCE = String.raw`
function collectPreserved(dir, suffix, since, depth, found) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0 && !["git-install", "npm", "node_modules", "tmp", "logs"].includes(entry.name)) {
        collectPreserved(file, suffix, since, depth - 1, found);
      }
    } else if (entry.name.endsWith(suffix) && fs.lstatSync(file).ctimeMs >= since) {
      found.push(file.slice(0, -suffix.length));
    }
  }
  return found;
}

function restoreState(files, suffix) {
  const restored = new Set(files);
  for (const file of files) {
    for (const companion of ["-wal", "-journal", "-shm", ".seal"]) {
      if (!restored.has(file + companion)) {
        fs.rmSync(file + companion, { force: true });
      }
    }
  }
  for (const file of files) {
    if (fs.existsSync(file + suffix)) {
      fs.renameSync(file + suffix, file);
    }
  }
}

function retirePlans(stateDir, generation) {
  const applied = path.join(stateDir, ".upgraded-" + generation + ".json");
  let record;
  try {
    record = JSON.parse(fs.readFileSync(applied, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  // Keep the record on failure so an interrupted rollback retries its removals.
  for (const op of record?.ops ?? []) {
    if (op.kind === "add") {
      fs.rmSync(op.live, { force: true });
    }
  }
  fs.rmSync(applied, { force: true });
  for (const entry of fs.readdirSync(stateDir)) {
    if (!entry.startsWith(".upgrade-" + generation + "-")) {
      continue;
    }
    const dir = path.join(stateDir, entry);
    let plan;
    try {
      plan = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"));
    } catch {}
    for (const op of plan?.ops ?? []) {
      if (op.kind === "add" && op.next && !fs.existsSync(op.next)) {
        fs.rmSync(op.live, { force: true });
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
`;
