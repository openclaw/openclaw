import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createNodeWorkerTempWorkspace } from "./node-worker-workspace-admission.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.skipIf(process.platform === "win32").each([
  [0o770, "group-writable", true],
  [0o707, "world-writable", true],
  [0o770, "group-writable", false],
] as const)(
  "explains unsafe ancestry mode %o without changing it",
  async (mode, description, rootExists) => {
    const ancestor = tempDirs.make("node-workspace-admission-");
    const rootDir = path.join(ancestor, "state", "node-host");
    if (rootExists) {
      await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
    }
    await fs.chmod(ancestor, mode);
    const canonicalAncestor = await fs.realpath(ancestor);
    try {
      await expect(createNodeWorkerTempWorkspace({ rootDir, prefix: "probe-" })).rejects.toThrow(
        `State directory ${canonicalAncestor} is ${description} without sticky protection; run chmod go-w`,
      );
      expect((await fs.stat(ancestor)).mode & 0o777).toBe(mode);
      if (rootExists) {
        expect(await fs.readdir(rootDir)).toEqual([]);
      } else {
        await expect(fs.stat(rootDir)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await fs.chmod(ancestor, 0o700);
    }
  },
);

it.skipIf(process.platform === "win32")(
  "admits a trusted sticky ancestor and cleans the probe",
  async () => {
    const ancestor = tempDirs.make("node-workspace-admission-sticky-");
    const rootDir = path.join(ancestor, "node-host");
    await fs.mkdir(rootDir, { mode: 0o700 });
    await fs.chmod(ancestor, 0o1777);
    try {
      const probe = await createNodeWorkerTempWorkspace({ rootDir, prefix: "probe-" });
      expect((await fs.stat(probe.dir)).mode & 0o777).toBe(0o700);
      await probe.cleanup();
      expect(await fs.readdir(rootDir)).toEqual([]);
      expect((await fs.stat(ancestor)).mode & 0o7777).toBe(0o1777);
    } finally {
      await fs.chmod(ancestor, 0o700);
    }
  },
);

async function runAdmissionProcess(policy: string | undefined, body = "", beforeAdmission = "") {
  const env = { ...process.env };
  delete env.OPENCLAW_NODE_TRUSTED_WRITABLE_ANCESTORS;
  if (policy !== undefined) {
    env.OPENCLAW_NODE_TRUSTED_WRITABLE_ANCESTORS = policy;
  }
  return await promisify(execFile)(
    process.execPath,
    [
      "--import",
      new URL("../../scripts/tsx.mjs", import.meta.url).href,
      "--input-type=module",
      "--eval",
      `import assert from "node:assert/strict";
       import fs from "node:fs/promises";
       import { execFileSync } from "node:child_process";
       ${beforeAdmission}
       const { createNodeWorkerTempWorkspace, withNodeWorkerTempWorkspace } =
         await import(${JSON.stringify(new URL("./node-worker-workspace-admission.ts", import.meta.url).href)});
       ${body}`,
    ],
    { env, timeout: 10_000 },
  );
}

it.skipIf(process.platform === "win32")(
  "uses one explicit ancestry policy for startup and later transfer workspaces",
  async () => {
    const ancestor = tempDirs.make("node-workspace-policy-");
    const rootDir = path.join(ancestor, "node-host");
    const nested = path.join(ancestor, "untrusted");
    const nestedRoot = path.join(nested, "node-host");
    await fs.mkdir(rootDir, { mode: 0o700 });
    await fs.mkdir(nestedRoot, { recursive: true, mode: 0o700 });
    await fs.chmod(ancestor, 0o770);
    await fs.chmod(nested, 0o770);
    try {
      const options = JSON.stringify({ rootDir, prefix: "probe-" });
      // Fresh processes prove the opt-in boundary without a module-cache reset or mock.
      await expect(
        runAdmissionProcess(undefined, `await createNodeWorkerTempWorkspace(${options});`),
      ).rejects.toThrow("group-writable");
      await runAdmissionProcess(
        JSON.stringify([ancestor]),
        `
        assert.equal(execFileSync(process.execPath,
          ["-p", "process.env.OPENCLAW_NODE_TRUSTED_WRITABLE_ANCESTORS"],
          { encoding: "utf8" }).trim(), "undefined");
        const probe = await createNodeWorkerTempWorkspace(${options});
        const file = await probe.writeText("startup.txt", "private startup");
        assert.equal(await fs.readFile(file, "utf8"), "private startup");
        assert.equal((await fs.stat(probe.dir)).mode & 0o777, 0o700);
        await probe.cleanup();
        // A later environment mutation cannot extend the admitted policy.
        process.env.OPENCLAW_NODE_TRUSTED_WRITABLE_ANCESTORS =
          ${JSON.stringify(JSON.stringify([ancestor, nested]))};
        await withNodeWorkerTempWorkspace(${options}, async (transfer) => {
          const file = await transfer.writeText("transfer.txt", "private transfer");
          assert.equal(await fs.readFile(file, "utf8"), "private transfer");
        });
        await assert.rejects(createNodeWorkerTempWorkspace(
          ${JSON.stringify({ rootDir: nestedRoot, prefix: "probe-" })}), /group-writable/);
      `,
      );
      expect(await fs.readdir(rootDir)).toEqual([]);
      expect((await fs.stat(ancestor)).mode & 0o777).toBe(0o770);
    } finally {
      await fs.chmod(nested, 0o700);
      await fs.chmod(ancestor, 0o700);
    }
  },
);

it.each(["invalid-json", "{}", '["/sandbox", 1]', '["relative"]', '["/tmp/.."]'])(
  "rejects malformed operator ancestry policy %s",
  async (policy) => {
    await expect(runAdmissionProcess(policy)).rejects.toThrow(
      "OPENCLAW_NODE_TRUSTED_WRITABLE_ANCESTORS must be a JSON array of canonical absolute paths",
    );
  },
);

it.skipIf(process.platform === "win32")(
  "shares initialized node policy with terminal upload recovery and temp-root selection",
  async () => {
    const parent = tempDirs.make("node-terminal-policy-");
    const ancestor = path.join(parent, "volume");
    const tempRoot = path.join(ancestor, "tmp");
    const nested = path.join(ancestor, "untrusted");
    const stale = path.join(tempRoot, "openclaw-terminal-upload-stale");
    const alias = path.join(parent, "alias");
    await fs.mkdir(stale, { recursive: true, mode: 0o700 });
    await fs.mkdir(nested, { mode: 0o770 });
    await fs.chmod(nested, 0o770);
    await fs.writeFile(path.join(stale, "old.txt"), "expired upload");
    await fs.utimes(stale, new Date(0), new Date(0));
    await fs.symlink(ancestor, alias, "dir");
    await fs.chmod(ancestor, 0o770);
    try {
      // Both preferred and state fallback roots sit below the volume, as in the node bootstrap.
      const strictCheck = `
        process.env.TMPDIR = ${JSON.stringify(tempRoot)};
        process.env.OPENCLAW_STATE_DIR = ${JSON.stringify(path.join(ancestor, "state"))};
        const { resolvePreferredOpenClawTmpDir } = await import(
          ${JSON.stringify(new URL("../infra/tmp-openclaw-dir.ts", import.meta.url).href)});
        const { ensureTerminalUploadCleanup, stageTerminalUpload } = await import(
          ${JSON.stringify(new URL("../infra/terminal-file-upload.ts", import.meta.url).href)});
        const options = { preferredDir: ${JSON.stringify(path.join(tempRoot, "private"))},
          tmpdir: () => process.env.TMPDIR };
        const upload = { name: "upload.txt", contentBase64: Buffer.from("node upload").toString("base64") };
        assert.throws(() => resolvePreferredOpenClawTmpDir(options), /No safe OpenClaw temp root/);
        await ensureTerminalUploadCleanup();
        assert.equal(await fs.readFile(${JSON.stringify(path.join(stale, "old.txt"))}, "utf8"), "expired upload");
        await assert.rejects(stageTerminalUpload(upload), /No safe OpenClaw temp root/);
      `;
      await runAdmissionProcess(undefined, strictCheck);
      // Merely importing shared consumers with the env setting present cannot activate it.
      await runAdmissionProcess(
        JSON.stringify([ancestor]),
        `
        assert.equal(resolvePreferredOpenClawTmpDir(options), options.preferredDir);
        await ensureTerminalUploadCleanup();
        await assert.rejects(fs.stat(${JSON.stringify(stale)}), { code: "ENOENT" });
        const uploaded = await stageTerminalUpload(upload);
        assert.equal(await fs.readFile(uploaded.path, "utf8"), "node upload");
        assert.equal((await fs.stat(uploaded.path)).mode & 0o777, 0o600);
        process.env.OPENCLAW_NODE_TRUSTED_WRITABLE_ANCESTORS = ${JSON.stringify(JSON.stringify([ancestor, nested]))};
        const nestedOptions = { preferredDir: ${JSON.stringify(path.join(nested, "private"))},
          tmpdir: () => ${JSON.stringify(nested)} };
        assert.notEqual(resolvePreferredOpenClawTmpDir(nestedOptions), nestedOptions.preferredDir);
      `,
        strictCheck,
      );
      await expect(runAdmissionProcess(JSON.stringify([alias]))).rejects.toThrow(
        "must be a JSON array of canonical absolute paths",
      );
      expect((await fs.stat(ancestor)).mode & 0o777).toBe(0o770);
    } finally {
      await fs.chmod(ancestor, 0o700);
      await fs.chmod(nested, 0o700);
    }
  },
);
