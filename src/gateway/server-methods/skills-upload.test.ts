import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { closeSkillsWatchers } from "../../skills/runtime/refresh.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

const agentScopeState = vi.hoisted(() => ({
  workspaceDir: "",
}));

const installSecurityScanState = vi.hoisted(() => ({
  evaluateSkillInstallPolicy: vi.fn(),
}));

const replaceFileState = vi.hoisted(() => ({
  publishFailureTarget: "",
  publishFailures: 0,
}));

vi.mock("../../agents/agent-scope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/agent-scope.js")>();
  return {
    ...actual,
    listAgentIds: vi.fn(() => ["main"]),
    resolveAgentWorkspaceDir: vi.fn(() => agentScopeState.workspaceDir),
    resolveDefaultAgentId: vi.fn(() => "main"),
  };
});

vi.mock("../../plugins/install-security-scan.js", () => ({
  evaluateSkillInstallPolicy: installSecurityScanState.evaluateSkillInstallPolicy,
}));

vi.mock("@openclaw/fs-safe/atomic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/fs-safe/atomic")>();
  return {
    ...actual,
    movePathWithCopyFallback: async (
      options: Parameters<typeof actual.movePathWithCopyFallback>[0],
    ) => {
      if (
        replaceFileState.publishFailures === 0 &&
        replaceFileState.publishFailureTarget &&
        options.from.includes(".openclaw-install-stage-") &&
        options.to === replaceFileState.publishFailureTarget
      ) {
        replaceFileState.publishFailures += 1;
        throw new Error("publish boom");
      }
      return await actual.movePathWithCopyFallback(options);
    },
  };
});

let testStates: OpenClawTestState[] = [];

type CallResult = {
  ok: boolean;
  payload?: unknown;
  error?: { code?: string; message?: string };
};

async function makeHarness(uploadOnly = false) {
  const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
  const testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-skill-upload-handler-",
  });
  testStates.push(testState);
  const stateDir = testState.stateDir;
  const workspaceDir = testState.workspaceDir;
  agentScopeState.workspaceDir = workspaceDir;
  const handlers = uploadOnly
    ? (await import("./skills-upload.js")).skillsUploadHandlers
    : (await import("./skills.js")).skillsHandlers;
  return {
    handlers,
    stateDir,
    workspaceDir,
    begin: (slug: string, archive: Buffer, extra = {}) =>
      beginUpload(handlers, slug, archive, extra),
    commit: (uploadId: string, extra = {}) =>
      call(handlers, "skills.upload.commit", { uploadId, ...extra }),
    chunk: (uploadId: string, archive: Buffer) =>
      call(handlers, "skills.upload.chunk", {
        uploadId,
        offset: 0,
        dataBase64: archive.toString("base64"),
      }),
    install: (uploadId: string, slug: string, extra = {}) =>
      call(handlers, "skills.install", { source: "upload", uploadId, slug, ...extra }),
  };
}

function makeContext(
  config: Record<string, unknown> = {
    skills: { install: { allowUploadedArchives: true } },
  },
) {
  return {
    getRuntimeConfig: () => config,
    logGateway: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  };
}

const beginUpload = (handlers: GatewayRequestHandlers, slug: string, archive: Buffer, extra = {}) =>
  call(handlers, "skills.upload.begin", {
    kind: "skill-archive",
    slug,
    sizeBytes: archive.length,
    ...extra,
  });
const uploadDb = (stateDir?: string) =>
  openOpenClawStateDatabase(
    stateDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } } : undefined,
  ).db;

async function call(
  handlers: GatewayRequestHandlers,
  method: string,
  params: Record<string, unknown>,
  options: { config?: Record<string, unknown> } = {},
): Promise<CallResult> {
  const handler = handlers[method];
  if (!handler) {
    throw new Error(`missing handler: ${method}`);
  }
  const respond = vi.fn<RespondFn>();
  await handler({
    params,
    req: { method } as never,
    client: null,
    isWebchatConnect: () => false,
    context: makeContext(options.config) as never,
    respond,
  });
  expect(respond).toHaveBeenCalledOnce();
  const [ok, payload, error] = respond.mock.calls[0]!;
  return { ok, payload, error };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

function skillUploadExists(stateDir: string, uploadId: string): boolean {
  return Boolean(
    uploadDb(stateDir).prepare("SELECT 1 FROM skill_uploads WHERE upload_id = ?").get(uploadId),
  );
}

function expectError(result: CallResult, code: string, message: string): void {
  expect(result.error).toEqual(expect.objectContaining({ code, message }));
}

function expectRejected(result: CallResult, code: string, message: string | RegExp) {
  expect(result).toMatchObject({
    ok: false,
    error: {
      code,
      message:
        typeof message === "string"
          ? expect.stringContaining(message)
          : expect.stringMatching(message),
    },
  });
}

function observeCommitSql() {
  const { DatabaseSync } = requireNodeSqlite();
  const sql = observeMainThreadSql();
  const close = vi.spyOn(DatabaseSync.prototype, "close");
  return {
    expectIdle() {
      sql.expectIdle();
      expect(close).not.toHaveBeenCalled();
    },
    [Symbol.dispose]() {
      close.mockRestore();
      sql.restore();
    },
  };
}

async function makeSkillArchive(params: {
  name?: string;
  body?: string;
  rootDir?: string;
  skillFileName?: string;
  traversal?: boolean;
  missingSkill?: boolean;
}): Promise<Buffer> {
  const zip = new JSZip();
  const prefix = params.rootDir ? `${params.rootDir.replace(/\/+$/, "")}/` : "";
  if (params.missingSkill) {
    zip.file(`${prefix}README.md`, "not a skill");
  } else {
    zip.file(
      `${prefix}${params.skillFileName ?? "SKILL.md"}`,
      `---\nname: ${params.name ?? "Uploaded Demo"}\ndescription: Installed from upload\n---\n\n${params.body ?? "# Uploaded demo"}\n`,
    );
  }
  if (params.traversal) {
    zip.file("../evil.txt", "owned");
  }
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

async function uploadArchive(
  handlers: GatewayRequestHandlers,
  params: {
    archive: Buffer;
    slug: string;
    force?: boolean;
  },
): Promise<{ uploadId: string; sha256: string }> {
  const digest = sha256(params.archive);
  const begin = await beginUpload(handlers, params.slug, params.archive, {
    sha256: digest,
    force: params.force,
  });
  expect(begin.ok).toBe(true);
  const uploadId = (begin.payload as { uploadId: string }).uploadId;
  const chunk = await call(handlers, "skills.upload.chunk", {
    uploadId,
    offset: 0,
    dataBase64: params.archive.toString("base64"),
  });
  expect(chunk.ok).toBe(true);
  const commit = await call(handlers, "skills.upload.commit", { uploadId, sha256: digest });
  expect(commit.ok).toBe(true);
  return { uploadId, sha256: digest };
}

describe("skill upload gateway handlers", () => {
  beforeEach(() => {
    testStates = [];
    replaceFileState.publishFailureTarget = "";
    replaceFileState.publishFailures = 0;
    installSecurityScanState.evaluateSkillInstallPolicy.mockReset();
    installSecurityScanState.evaluateSkillInstallPolicy.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
    // Close real skills.status watchers before retiring their workspace and state roots.
    await closeSkillsWatchers(true);
    await Promise.all(testStates.splice(0).map((state) => state.cleanup()));
  });

  it.each([true, false])(
    "stages and commits without caller-thread SQLite (upload-only: %s)",
    async (uploadOnly) => {
      const { begin, chunk, commit, stateDir } = await makeHarness(uploadOnly);
      const archive = Buffer.from("worker-owned archive commit");
      const digest = sha256(archive);
      await closeOpenClawStateDatabaseAsync();
      let uploadId: string;
      {
        using sql = observeCommitSql();
        const started = await begin("worker-commit", archive, uploadOnly ? {} : { sha256: digest });
        expect(started.ok).toBe(true);
        sql.expectIdle();
        uploadId = (started.payload as { uploadId: string }).uploadId;
        expect(await chunk(uploadId, archive)).toMatchObject({ ok: true });
        if (!uploadOnly) {
          closeOpenClawStateDatabaseForTest();
        }
        const committed = await commit(uploadId, uploadOnly ? {} : { sha256: digest });
        expect(committed).toMatchObject({
          ok: true,
          payload: { uploadId, receivedBytes: archive.length, sha256: digest },
        });
        if (!uploadOnly) {
          expect(await commit(uploadId)).toEqual(committed);
          const mismatch = await commit(uploadId, { sha256: "0".repeat(64) });
          expectError(mismatch, "INVALID_REQUEST", "upload sha256 mismatch");
        }
        await closeOpenClawStateDatabaseAsync();
        sql.expectIdle();
      }
      if (uploadOnly) {
        return;
      }
      const db = uploadDb(stateDir);
      const stored = db
        .prepare(
          "SELECT archive_blob, actual_sha256, committed FROM skill_uploads WHERE upload_id = ?",
        )
        .get(uploadId);
      expect(stored).toMatchObject({
        archive_blob: new Uint8Array(archive),
        actual_sha256: digest,
        committed: 1,
      });
      expect(
        db
          .prepare("SELECT count(*) AS count FROM skill_upload_chunks WHERE upload_id = ?")
          .get(uploadId),
      ).toEqual({ count: 0 });
    },
  );

  it.each([false, true])(
    "settles an expired commit without caller SQLite with external install lease=%s",
    async (leased) => {
      const { handlers, commit, stateDir } = await makeHarness();
      const { uploadId } = await uploadArchive(handlers, {
        archive: Buffer.from("expired archive"),
        slug: "expired-commit",
      });
      const db = uploadDb();
      const now = Date.now();
      db.prepare("UPDATE skill_uploads SET expires_at = ? WHERE upload_id = ?").run(
        now - 1,
        uploadId,
      );
      if (leased) {
        db.prepare(
          "INSERT INTO state_leases (scope, lease_key, owner, expires_at, heartbeat_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run("skill-upload-install", uploadId, "external-install", now + 60_000, now, now, now);
      }
      await closeOpenClawStateDatabaseAsync();
      {
        using sql = observeCommitSql();
        const result = await commit(uploadId);
        expectError(result, "INVALID_REQUEST", "upload has expired");
        await closeOpenClawStateDatabaseAsync();
        sql.expectIdle();
      }
      expect(skillUploadExists(stateDir, uploadId)).toBe(leased);
      const reopened = uploadDb();
      expect(
        reopened
          .prepare("SELECT count(*) AS count FROM state_leases WHERE scope = ? AND lease_key = ?")
          .get("skill-upload-install", uploadId),
      ).toEqual({ count: leased ? 1 : 0 });
    },
  );

  it("rejects upload archive RPCs and upload installs when disabled by config", async () => {
    const { handlers, stateDir } = await makeHarness();
    const config = { skills: { install: { allowUploadedArchives: false } } };
    for (const [method, params] of [
      ["skills.upload.begin", { kind: "skill-archive", sizeBytes: 1 }],
      ["skills.install", { source: "upload", uploadId: randomUUID() }],
    ] as const) {
      const result = await call(
        handlers,
        method,
        { ...params, slug: "disabled-skill" },
        { config },
      );
      expectRejected(result, "UNAVAILABLE", "skills.install.allowUploadedArchives");
      if (method === "skills.upload.begin") {
        await expectPathMissing(path.join(stateDir, "tmp", "skill-uploads"));
      }
    }
  });

  it("uploads, installs, cleans up, and reports the skill from status", async () => {
    const { handlers, install: installArchive, stateDir, workspaceDir } = await makeHarness();
    const archive = await makeSkillArchive({
      name: "Uploaded Demo",
      rootDir: "archive-internal-name",
    });
    const { uploadId, sha256: digest } = await uploadArchive(handlers, {
      archive,
      slug: "uploaded-demo",
    });

    const install = await installArchive(uploadId, "uploaded-demo", { sha256: digest });
    expect(install).toMatchObject({
      ok: true,
      payload: { ok: true, slug: "uploaded-demo", sha256: digest },
    });
    await expect(
      fs.readFile(path.join(workspaceDir, "skills", "uploaded-demo", "SKILL.md"), "utf8"),
    ).resolves.toContain("Uploaded Demo");
    await expectPathMissing(path.join(workspaceDir, "skills", "archive-internal-name"));
    expect(skillUploadExists(stateDir, uploadId)).toBe(false);
    await expectPathMissing(path.join(stateDir, "tmp", "skill-uploads"));

    const status = await call(handlers, "skills.status", {});
    expect(status.ok).toBe(true);
    expect(JSON.stringify(status.payload)).toContain("Uploaded Demo");
  });

  it("rejects traversal slugs before staging", async () => {
    const { handlers } = await makeHarness();
    const result = await call(handlers, "skills.upload.begin", {
      kind: "skill-archive",
      slug: "../escape",
      sizeBytes: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Invalid skill slug");
  });

  it.each([
    ["pending", "upload is not committed"],
    ["missing", "upload not found"],
    ["slug", "install slug does not match upload slug"],
    ["force", "install force does not match upload force"],
    ["sha", "install sha256 does not match uploaded archive"],
    ["expired", "upload has expired"],
    ["missing-skill", "SKILL.md"],
    ["legacy-marker", "SKILL.md"],
    ["traversal", /escapes destination|absolute|extract archive/i],
    ["policy", "blocked by install policy"],
  ] as const)("rejects %s installs and preserves terminal cleanup", async (kind, message) => {
    const {
      handlers,
      install: installArchive,
      begin,
      stateDir,
      workspaceDir,
    } = await makeHarness();
    const slug = kind === "policy" ? "scan-blocked" : "rejected-skill";
    const archive = await makeSkillArchive({
      missingSkill: kind === "missing-skill",
      traversal: kind === "traversal",
      ...(kind === "legacy-marker" ? { rootDir: "legacy-root", skillFileName: "skills.md" } : {}),
    });
    let uploadId: string;
    if (kind === "missing") {
      uploadId = randomUUID();
    } else if (kind === "pending") {
      const started = await begin(slug, archive);
      uploadId = (started.payload as { uploadId: string }).uploadId;
    } else {
      ({ uploadId } = await uploadArchive(handlers, { archive, slug, force: kind === "force" }));
    }
    if (kind === "expired") {
      uploadDb(stateDir)
        .prepare("UPDATE skill_uploads SET expires_at = ? WHERE upload_id = ?")
        .run(Date.now() - 1, uploadId);
    }
    if (kind === "policy") {
      installSecurityScanState.evaluateSkillInstallPolicy.mockResolvedValueOnce({
        blocked: {
          code: "security_scan_blocked",
          reason: 'blocked by install policy: Skill "scan-blocked" is not approved.',
        },
      });
    }
    const install = await installArchive(
      uploadId,
      kind === "slug" ? "other-skill" : slug,
      kind === "sha" ? { sha256: "0".repeat(64) } : {},
    );
    expectRejected(install, "INVALID_REQUEST", message);
    if (kind === "sha" || kind === "expired") {
      expect(install.error?.message).toBe(message);
    }
    if (["sha", "expired", "missing-skill", "legacy-marker", "policy"].includes(kind)) {
      expect(skillUploadExists(stateDir, uploadId)).toBe(false);
    }
    if (kind === "traversal") {
      await expectPathMissing(path.join(workspaceDir, "skills", slug));
    }
    if (kind === "policy") {
      expect(installSecurityScanState.evaluateSkillInstallPolicy.mock.calls[0]?.[0]).toMatchObject({
        origin: { type: "upload", uploadId },
        skillName: "scan-blocked",
      });
    }
  });

  it.each([false, true])(
    "replaces only with bound force and rolls back publication failure=%s",
    async (publishFails) => {
      const { handlers, install: installArchive, stateDir, workspaceDir } = await makeHarness();
      const slug = "replace-demo";
      const uploadVersion = async (body: string, force = false) =>
        uploadArchive(handlers, {
          archive: await makeSkillArchive({ name: "Replace Demo", body }),
          slug,
          force,
        });
      const installVersion = (uploadId: string, force = false) =>
        installArchive(uploadId, slug, { force });
      const first = await uploadVersion("first version");
      expect((await installVersion(first.uploadId)).ok).toBe(true);
      if (publishFails) {
        replaceFileState.publishFailureTarget = path.join(
          await fs.realpath(path.join(workspaceDir, "skills")),
          slug,
        );
      } else {
        const blocked = await uploadVersion("second version");
        const install = await installVersion(blocked.uploadId);
        expectRejected(install, "INVALID_REQUEST", "already exists");
        expect(skillUploadExists(stateDir, blocked.uploadId)).toBe(false);
      }
      const forced = await uploadVersion("second version", true);
      const install = await installVersion(forced.uploadId, true);
      expect(install.ok).toBe(!publishFails);
      if (publishFails) {
        expectRejected(install, "UNAVAILABLE", "publish boom");
        expect(skillUploadExists(stateDir, forced.uploadId)).toBe(true);
      }
      await expect(
        fs.readFile(path.join(workspaceDir, "skills", slug, "SKILL.md"), "utf8"),
      ).resolves.toContain(publishFails ? "first version" : "second version");
    },
  );
});
