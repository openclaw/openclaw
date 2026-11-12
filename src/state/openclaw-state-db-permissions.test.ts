import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { ensurePrivateSnapshotRepositoryRoot } from "../snapshot/local-repository.js";
import {
  ensureOpenClawStatePermissions,
  restorePrivateUpdateCaptureRootMode,
} from "./openclaw-state-db-permissions.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

const openFailure = vi.hoisted(() => {
  // Runtime setup can capture named filesystem imports before this test loads.
  vi.resetModules();
  return { target: undefined as string | undefined, attempted: false };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const openSync: typeof actual.openSync = (target, flags, mode) => {
    if (target === openFailure.target) {
      openFailure.attempted = true;
      throw Object.assign(new Error("fixture access refused"), { code: "EACCES" });
    }
    return actual.openSync(target, flags, mode);
  };
  return { ...actual, openSync, default: { ...actual, openSync } };
});

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  openFailure.target = undefined;
  openFailure.attempted = false;
  vi.restoreAllMocks();
});

function fixture() {
  const parent = dirs.make("capture-root-permissions-");
  const stateDir = path.join(parent, "state");
  const captureRoot = `${stateDir}.update-captures`;
  fs.mkdirSync(stateDir);
  fs.mkdirSync(captureRoot);
  return { stateDir, captureRoot, env: { OPENCLAW_STATE_DIR: stateDir } };
}

it.skipIf(process.platform === "win32")(
  "restores an owned remounted capture root before the real snapshot owner admits it",
  async () => {
    const { stateDir, captureRoot, env } = fixture();
    const payload = path.join(captureRoot, "retained");
    fs.writeFileSync(payload, "original bytes");
    fs.chmodSync(payload, 0o660);
    fs.chmodSync(stateDir, 0o770);
    fs.chmodSync(captureRoot, 0o2770);
    await expect(ensurePrivateSnapshotRepositoryRoot(captureRoot)).rejects.toThrow();
    restorePrivateUpdateCaptureRootMode(env);
    await expect(ensurePrivateSnapshotRepositoryRoot(captureRoot)).resolves.toBeDefined();
    expect(fs.statSync(captureRoot).mode & 0o7777).toBe(0o700);
    expect(fs.statSync(stateDir).mode & 0o777).toBe(0o770);
    expect(fs.statSync(payload).mode & 0o777).toBe(0o660);
    expect(fs.readFileSync(payload, "utf8")).toBe("original bytes");
    const before = fs.lstatSync(captureRoot, { bigint: true });
    restorePrivateUpdateCaptureRootMode(env);
    expect(fs.lstatSync(captureRoot, { bigint: true }).ctimeNs).toBe(before.ctimeNs);
  },
);

it.skipIf(process.platform === "win32").each(["world", "foreign", "symlink", "file", "missing"])(
  "leaves an unadmitted capture root untouched: %s",
  (kind) => {
    const { captureRoot, env } = fixture();
    let observed = captureRoot;
    if (kind === "missing" || kind === "file" || kind === "symlink") {
      fs.rmdirSync(captureRoot);
    }
    if (kind === "file") {
      fs.writeFileSync(captureRoot, "not a directory");
    } else if (kind === "symlink") {
      observed = `${captureRoot}-elsewhere`;
      fs.mkdirSync(observed);
      fs.symlinkSync(observed, captureRoot, "dir");
    }
    if (kind !== "missing") {
      fs.chmodSync(observed, kind === "world" ? 0o2777 : 0o2770);
    }
    if (kind === "foreign") {
      vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
    }
    const before = fs.lstatSync(observed, { bigint: true, throwIfNoEntry: false });
    restorePrivateUpdateCaptureRootMode(env);
    const after = fs.lstatSync(observed, { bigint: true, throwIfNoEntry: false });
    expect(after?.mode).toBe(before?.mode);
    expect(after?.ctimeNs).toBe(before?.ctimeNs);
  },
);

it.skipIf(process.platform === "win32")(
  "ordinary shared-state permission writes never restore sibling capture modes",
  () => {
    const { captureRoot, env } = fixture();
    fs.chmodSync(captureRoot, 0o2770);
    const before = fs.lstatSync(captureRoot, { bigint: true });
    ensureOpenClawStatePermissions(resolveOpenClawStateSqlitePath(env), env, {
      createDirectory: true,
    });
    const after = fs.lstatSync(captureRoot, { bigint: true });
    expect(after.mode).toBe(before.mode);
    expect(after.ctimeNs).toBe(before.ctimeNs);
  },
);

it.skipIf(process.platform === "win32")(
  "root mode restoration does not admit unsafe mount ancestry",
  async () => {
    const { stateDir, captureRoot, env } = fixture();
    fs.chmodSync(path.dirname(stateDir), 0o770);
    fs.chmodSync(captureRoot, 0o2770);
    restorePrivateUpdateCaptureRootMode(env);
    expect(fs.statSync(captureRoot).mode & 0o7777).toBe(0o700);
    await expect(ensurePrivateSnapshotRepositoryRoot(captureRoot)).rejects.toThrow();
  },
);

it.skipIf(process.platform === "win32")(
  "leaves an unopenable root to the capture owner's refusal",
  () => {
    const { captureRoot, env } = fixture();
    fs.chmodSync(captureRoot, 0o2770);
    const before = fs.lstatSync(captureRoot, { bigint: true });
    openFailure.target = captureRoot;
    restorePrivateUpdateCaptureRootMode(env);
    expect(openFailure.attempted).toBe(true);
    const after = fs.lstatSync(captureRoot, { bigint: true });
    expect(after.mode).toBe(before.mode);
    expect(after.ctimeNs).toBe(before.ctimeNs);
  },
);
