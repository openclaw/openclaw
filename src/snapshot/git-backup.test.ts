import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { formatCliOperatorError } from "../cli/failure-output.js";
import { backupGitCreateCommand, backupGitLogCommand } from "../commands/backup-git.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import { clearRuntimeConfigSnapshot } from "../config/config.js";
import { executeGitCommand, requireGitCommand as requireGit } from "../infra/git-exec.js";
import * as gitExec from "../infra/git-exec.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { redactSensitiveText } from "../logging/redact.js";
import { spawnCommand } from "../process/exec-spawn.js";
import { readBackupRunFreshness } from "../state/backup-run-records.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  closeOpenClawStateDatabaseAsync,
} from "../state/openclaw-state-db.js";
import { createPathResolutionEnv } from "../test-utils/env.js";
import { dumpGitBackupDatabase, restoreGitBackupDirectory } from "./git-backup-codec.js";
import { gitBackupCommandRuntimeEntrypoint } from "./git-backup-command-runtime.test-support.js";
import { createGitBackup, initializeGitBackupRepository } from "./git-backup.js";
import {
  createCatalogFixture,
  createFormatFixture,
  createStateDatabaseFixture,
  expectDatabaseRows,
  gitBackupRepository,
  withBackupStateEnv,
} from "./git-backup.test-support.js";
import * as localRepository from "./local-repository.js";
import { withDatabase } from "./local-repository.test-support.js";

function failGit(command: "log" | "push", diagnostic: { stdout: string; stderr: string }) {
  const execute = gitExec.executeGitCommand;
  vi.spyOn(gitExec, "executeGitCommand").mockImplementation(async (...args) =>
    args[1][0] === command
      ? {
          ...diagnostic,
          code: 1,
          signal: null,
          killed: false,
          termination: "exit",
          timeoutMs: args[2]?.timeoutMs ?? gitExec.GIT_TIMEOUT_MS,
        }
      : execute(...args),
  );
}

const roots = createTempDirTracker();
const tempRoot = () => roots.make("openclaw-git-backup-test-");

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawAgentDatabasesForTest();
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
  roots.cleanup();
});

async function backupFixture(name = "repository") {
  const root = tempRoot();
  const state = createStateDatabaseFixture(root);
  const repo = gitBackupRepository(root, name);
  return {
    ...state,
    ...repo,
    create: (extra: Partial<Parameters<typeof createGitBackup>[0]> = {}) =>
      createGitBackup({ ...repo.options, databases: [state.database], ...extra }),
    command: (runtime = createTestRuntime()) =>
      backupGitCreateCommand(runtime, {
        repository: repo.repositoryPath,
        global: true,
        push: true,
        excludeSecrets: true,
      }),
  };
}

async function repositoryFixture(name = "repository") {
  const repo = gitBackupRepository(tempRoot(), name);
  await fs.mkdir(repo.stateDir);
  return repo;
}

async function agentFixture(stateDir: string, agentId: string, agentDir: string) {
  await fs.mkdir(agentDir, { recursive: true });
  const { closeOpenClawAgentDatabaseByPath, openOpenClawAgentDatabase } =
    await import("../state/openclaw-agent-db.js");
  const database = openOpenClawAgentDatabase({
    agentId,
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    path: path.join(agentDir, "openclaw-agent.sqlite"),
  });
  closeOpenClawAgentDatabaseByPath(database.path);
  return { agentDir };
}

function codecFixture(root = tempRoot(), source = path.join(root, "source.sqlite")) {
  const dump = path.join(root, "dump");
  const restoredPath = path.join(root, "restored.sqlite");
  return {
    source,
    dump,
    restoredPath,
    read: (name: string) => fs.readFile(path.join(dump, name), "utf8"),
    dumpDatabase: (
      excludeSecrets = true,
      identity: Parameters<typeof dumpGitBackupDatabase>[0]["identity"] = { role: "global" },
    ) =>
      dumpGitBackupDatabase({ snapshotPath: source, outputPath: dump, identity, excludeSecrets }),
    restore: (expectedIdentity?: { role: "global" }) =>
      restoreGitBackupDirectory({
        sourcePath: dump,
        targetPath: restoredPath,
        expectedIdentity,
      }),
  };
}

async function formatFixture() {
  const fixture = codecFixture();
  await createFormatFixture(fixture.source);
  return fixture;
}

function expectText(text: string | undefined, present: string[], absent: string[] = []) {
  for (const value of present) {
    expect(text).toContain(value);
  }
  for (const value of absent) {
    expect(text).not.toContain(value);
  }
}

function gitDiagnostic(remote: string, stderr: string, stdout: string) {
  const stream = (label: string, tail: string) =>
    [...Array.from({ length: 20 }, (_, index) => `${label}-old-${index} '${remote}'`), tail].join(
      "\n",
    );
  return { stderr: stream("stderr", stderr), stdout: stream("stdout", stdout) };
}

const credentials = ["synthetic-user", "synthetic-password", "synthetic-query"];
const authenticatedUrl = (resource: string) =>
  `https://${credentials[0]}:${credentials[1]}@example.invalid/${resource}=${credentials[2]}`;
function expectDiagnostics(text: string | undefined, redactedUrl: string, extra: string[] = []) {
  expectText(
    text,
    ["stderr:", "stdout:", "stderr-tail-🦞", "stdout-tail-🐚", redactedUrl, ...extra],
    credentials,
  );
}
async function captureError(operation: Promise<unknown>) {
  const error = await operation.catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) {
    throw new Error("expected operation to fail");
  }
  return error;
}

it("rejects state and repository overlap in either canonical direction", async () => {
  const root = await fs.realpath(tempRoot());
  const stateDir = path.join(root, "state");
  await fs.mkdir(stateDir, { recursive: true });
  const stateAlias = path.join(root, "state-alias");
  await fs.symlink(stateDir, stateAlias, process.platform === "win32" ? "junction" : "dir");

  for (const repositoryPath of [
    path.join(stateDir, "backup"),
    root,
    path.join(stateAlias, "backup"),
  ]) {
    await expect(initializeGitBackupRepository({ repositoryPath, stateDir })).rejects.toThrow(
      `Git backup repository must be outside the OpenClaw state directory: ${stateDir}`,
    );
  }
});

it("backs up an explicitly selected external agent database", async () => {
  const root = await fs.realpath(tempRoot());
  const { stateDir } = createStateDatabaseFixture(root);
  const agentDir = path.join(root, "external-agent");
  const configPath = path.join(stateDir, "openclaw.json");
  await agentFixture(stateDir, "main", agentDir);
  await fs.writeFile(configPath, JSON.stringify({ agents: { entries: { main: { agentDir } } } }));

  await withBackupStateEnv(
    { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
    async () => {
      const repositoryPath = path.join(root, "repository");
      await initializeGitBackupRepository({ repositoryPath, stateDir });
      const result = await backupGitCreateCommand(createTestRuntime(), {
        repository: repositoryPath,
        agents: ["main"],
      });
      const manifest = JSON.parse(
        await fs.readFile(path.join(repositoryPath, "agents/main/manifest.json"), "utf8"),
      ) as { identity: { role: string; agentId: string } };
      expect(result.commit).toMatch(/^[a-f0-9]{40}$/u);
      expect(manifest.identity).toEqual({ role: "agent", agentId: "main" });
    },
  );
});

it.each(["missing", "old-schema", "removed"] as const)(
  "refreshes --all backups without losing a configured %s agent",
  async (condition) => {
    clearRuntimeConfigSnapshot();
    const root = await fs.realpath(tempRoot());
    const { stateDir } = createStateDatabaseFixture(root);
    const { repositoryPath, options, git, file } = gitBackupRepository(root);
    const configPath = path.join(stateDir, "openclaw.json");
    const entries = {
      main: await agentFixture(stateDir, "main", path.join(root, "main")),
      ops: await agentFixture(stateDir, "ops", path.join(root, "ops")),
    };
    const writeConfig = (selected: Partial<typeof entries>) =>
      fs.writeFile(
        configPath,
        JSON.stringify({ agents: { ownership: "explicit", entries: selected } }),
      );
    await writeConfig(entries);
    await closeOpenClawStateDatabaseAsync();

    await withBackupStateEnv(
      { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
      async () => {
        const create = (agentId?: string) =>
          spawnCommand(
            [
              process.execPath,
              ...resolveRuntimeWorkerArgv(
                resolveRuntimeWorkerUrl(gitBackupCommandRuntimeEntrypoint),
              ),
              repositoryPath,
              ...(agentId ? [agentId] : []),
            ],
            { env: { OPENCLAW_TEST_RUNTIME_LOG: "1" }, timeout: 30_000 },
          );
        const resultSchema = z.object({
          commit: z.string(),
          warnings: z.array(z.string()).optional(),
        });
        const first = resultSchema.parse(JSON.parse((await create()).stdout));
        await expect(fs.stat(file("global/manifest.json"))).resolves.toBeDefined();
        const opsTree = await git("rev-parse", "HEAD:agents/ops");
        const mainTree = await git("rev-parse", "HEAD:agents/main");
        withDatabase(path.join(entries.main.agentDir, "openclaw-agent.sqlite"), (main) => {
          main.exec("UPDATE schema_meta SET updated_at = updated_at + 1");
        });
        const opsPath = path.join(entries.ops.agentDir, "openclaw-agent.sqlite");
        if (condition === "missing") {
          await fs.rm(opsPath);
        } else if (condition === "old-schema") {
          withDatabase(opsPath, (ops) => {
            ops.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION - 1}`);
          });
        } else {
          await writeConfig({ main: entries.main });
        }
        const retainedArtifact = "agents/ops/tables/schema_meta.jsonl";
        const retainedPath = file(retainedArtifact);
        let stagedBlob: string | undefined;
        if (condition !== "removed") {
          await fs.writeFile(retainedPath, "operator staged bytes\n");
          await git("add", "--", retainedArtifact);
          stagedBlob = await git("rev-parse", `:${retainedArtifact}`);
          await fs.writeFile(retainedPath, "operator unstaged bytes\n");
        }
        const output = await create();
        const result = resultSchema.parse(JSON.parse(output.stdout));
        expect(result.commit).toMatch(/^[a-f0-9]{40}$/u);
        expect(result.commit).not.toBe(first.commit);
        expect(await git("rev-parse", "HEAD:agents/main")).not.toBe(mainTree);
        if (condition === "removed") {
          expect(await git("ls-tree", "HEAD", "agents/ops")).toBe("");
          expect(output.stderr).not.toContain("Warning: Agent");
          return;
        }
        expect(await git("rev-parse", "HEAD:agents/ops")).toBe(opsTree);
        expect(await git("rev-parse", `:${retainedArtifact}`)).toBe(stagedBlob);
        await expect(fs.readFile(retainedPath, "utf8")).resolves.toBe("operator unstaged bytes\n");
        const reason = condition === "missing" ? /ENOENT/u : /uses schema version/u;
        expect(result.warnings).toEqual([expect.stringMatching(/agent ops.*degraded/iu)]);
        const warning = result.warnings?.[0];
        expect(warning).toMatch(reason);
        expect(output.stderr).toContain(`Warning: ${warning}`);
        expect((await readBackupRunFreshness(process.env)).latest).toMatchObject({
          status: "ok",
          kind: "git",
          target: result.commit,
          error: warning,
        });
        await expect(create("ops")).rejects.toThrow(reason);
        await expect(
          createGitBackup({
            ...options,
            all: true,
            databases: [{ path: opsPath, identity: { role: "agent", agentId: "ops" } }],
          }),
        ).rejects.toThrow("No Git backup databases were found for the selected scope.");
        expect(await git("rev-parse", "HEAD")).toBe(result.commit);
      },
    );
  },
);

it.skipIf(process.platform === "win32")(
  "rejects group-writable adopted roots with a chmod hint",
  async () => {
    const { repositoryPath, init } = await repositoryFixture();
    await fs.mkdir(repositoryPath, { mode: 0o700 });
    await fs.chmod(repositoryPath, 0o770);

    await expect(init()).rejects.toThrow(/chmod 700/u);
  },
);

it("gives Windows ACL remediation instead of a POSIX chmod command", async () => {
  const { init } = await repositoryFixture();
  vi.spyOn(localRepository, "ensurePrivateSnapshotRepositoryRoot").mockRejectedValue(
    new Error(
      "Windows ACL permits untrusted SQLite staging access on repository root: path=C:\\backups principal=S-1-1-0 rights=FullControl.",
    ),
  );
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");

  const error = await captureError(init());

  const output = formatCliOperatorError(error, { argv: [], env: {} });

  expectText(
    output,
    [
      "Windows ACL permits untrusted SQLite staging access",
      "path=C:\\backups principal=S-1-1-0 rights=FullControl",
      "Remove non-user ACL grants",
      "Do not use a shared or synced folder",
    ],
    ["chmod 700"],
  );
});

it.skipIf(process.platform !== "win32")(
  "initializes and reads history when Windows Git emits MSYS paths",
  async () => {
    const { init, log, write, commit, configureIdentity } = await repositoryFixture();
    await init();
    await configureIdentity();
    await write("README.md", "backup\n");
    await commit("backup history", "README.md");
    await expect(log(1)).resolves.toEqual([expect.objectContaining({ message: "backup history" })]);
  },
);

it("uses a commit-scoped fallback identity when Git has no configured email", async () => {
  const { root, repositoryPath, create } = await backupFixture("identity-free-repository");
  const isolatedHome = path.join(root, "git-home");
  await fs.mkdir(isolatedHome, { recursive: true });
  const gitEnv = createPathResolutionEnv(isolatedHome, {
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  });

  const result = await withBackupStateEnv(gitEnv, () => create());

  expect(result.commit).toMatch(/^[a-f0-9]{40}$/u);
  expect(
    await requireGit(repositoryPath, ["log", "-1", "--format=%an <%ae>"], { env: gitEnv }),
  ).toBe("OpenClaw <backup@openclaw.local>");
  expect(
    await requireGit(repositoryPath, ["config", "--local", "--get", "user.email"], {
      env: gitEnv,
    }).catch(() => undefined),
  ).toBeUndefined();
});

it("redacts and durably preserves credential-bearing push diagnostics", async () => {
  const { stateDir, init, command, configureIdentity } = await backupFixture("push-repository");
  const remote = authenticatedUrl("repository?access_token");
  failGit(
    "push",
    gitDiagnostic(
      remote,
      `stderr-tail-🦞 fatal: unable to access '${remote}'`,
      `stdout-tail-🐚 remote: rejected '${remote}'`,
    ),
  );
  await init(remote);
  await configureIdentity();

  await withBackupStateEnv({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    const runtime = createTestRuntime();
    const result = await command(runtime);

    expectDiagnostics(
      result.pushWarning,
      "https://***:***@example.invalid/repository?access_token=***",
    );
    expect(result.pushWarning?.length).toBeLessThanOrEqual(1_200);
    const warning = runtime.error.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.startsWith("Warning: Git backup committed, but push failed: "));
    expectDiagnostics(warning, "https://***:***@example.invalid/repository?access_token=***");
    expectDiagnostics(
      redactSensitiveText(warning ?? ""),
      "https://***:***@example.invalid/repository?access_token=***",
    );
    expect(warning).toContain("\\n");
    expect(warning).not.toMatch(/\p{Cc}/u);

    const persisted = (await readBackupRunFreshness(process.env)).latest?.error;
    expect(persisted).toBe(result.pushWarning);
  });
});

it("returns an empty log without matching localized Git diagnostics", async () => {
  const { repositoryPath, root } = await repositoryFixture("empty-repository");
  await requireGit(root, ["init", repositoryPath]);
  failGit("log", {
    stdout: "",
    stderr: "fatal: el historial no contiene confirmaciones",
  });
  const runtime = createTestRuntime();

  await expect(
    backupGitLogCommand(runtime, { repository: repositoryPath, limit: 10 }),
  ).resolves.toEqual([]);
  expect(runtime.log).toHaveBeenCalledWith(
    expect.stringMatching(/No Git backup commits in .*\/empty-repository\.$/u),
  );
});

it("returns bounded redacted diagnostics from both failed history streams", async () => {
  const { repositoryPath, root, git } = await repositoryFixture();
  const remote = authenticatedUrl("history?token");
  await requireGit(root, ["init", repositoryPath]);
  await git(
    "-c",
    "user.name=OpenClaw Backup Test",
    "-c",
    "user.email=backup@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "openclaw backup fixture",
  );
  await git("checkout", "--detach", "HEAD");
  failGit(
    "log",
    gitDiagnostic(
      remote,
      `${"🦞".repeat(400)}x stderr-tail-🦞 fatal: unable to read '${remote}'`,
      `stdout-tail-🐚 retry with '${remote}'`,
    ),
  );

  const error = await captureError(
    backupGitLogCommand(createTestRuntime(), {
      repository: repositoryPath,
      limit: 10,
    }),
  );
  const output = formatCliOperatorError(error, { argv: ["backup", "git", "log"], env: {} });

  expect(error.message.length).toBeLessThanOrEqual(1_200);
  expectDiagnostics(output, "https://***:***@example.invalid/history?token=***", [
    "git log failed (code=1, termination=exit)",
  ]);
  expect(output).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  expect(output).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
});

it("rejects a truncated Git history record with bounded redacted diagnostics", async () => {
  const { repositoryPath, git, log, file } = await repositoryFixture();
  await fs.mkdir(repositoryPath);
  await git("init");
  const tree = await requireGit(repositoryPath, ["hash-object", "-w", "-t", "tree", "--stdin"], {
    input: "",
  });
  const secret = ["synthetic", "history", "password"].join("-");
  const remote = `https://synthetic:${secret}@example.invalid/history`;
  const commit = await requireGit(
    repositoryPath,
    [
      "-c",
      "user.name=OpenClaw Backup Test",
      "-c",
      "user.email=backup@example.invalid",
      "commit-tree",
      tree,
    ],
    { input: `openclaw backup ${"x".repeat(17 * 1024 * 1024)} ${remote}\n` },
  );
  await fs.writeFile(file(".git", "HEAD"), `${commit}\n`);
  const error = await captureError(log(1));
  expect(error.message.length).toBeLessThanOrEqual(1_200);
  expectText(error.message, ["output-limit", "https://***:***@example.invalid/history"], [secret]);
});

it.each(["missing object", "non-branch ref"])(
  "does not treat a symbolic HEAD with %s as an empty log",
  async (condition) => {
    const { root, repositoryPath, git, file, log } = await repositoryFixture();
    await requireGit(root, ["init", repositoryPath]);
    if (condition === "missing object") {
      const headRef = await git("symbolic-ref", "HEAD");
      const headRefPath = file(".git", ...headRef.split("/"));
      await fs.mkdir(path.dirname(headRefPath), { recursive: true });
      await fs.writeFile(headRefPath, `${"a".repeat(40)}\n`);
    } else {
      await git("symbolic-ref", "HEAD", "refs/tags/missing");
    }
    await expect(log()).rejects.toThrow(/git show-ref/u);
  },
);

it.each([false, true])(
  "pushes only backup ancestry and records local degradation (adopted=%s)",
  async (adopted) => {
    const { root, stateDir, init, create, command, git, write, commit, configureIdentity } =
      await backupFixture();
    const remotePath = path.join(root, "remote.git");
    await requireGit(root, ["init", "--bare", remotePath]);
    await init(remotePath);
    await configureIdentity();
    if (!adopted) {
      const result = await create({ push: true });
      const branch = await git("branch", "--show-current");
      expect(result).toMatchObject({ noChanges: false, pushed: true });
      expect(result).not.toHaveProperty("pushWarning");
      expect(await requireGit(remotePath, ["rev-parse", `refs/heads/${branch}`])).toBe(
        result.commit,
      );
      return;
    }
    await write("unrelated.txt", "operator-owned\n");
    await commit("operator history", "unrelated.txt");

    const warning =
      "repository history contains non-backup commits; use a dedicated backup repository";
    await withBackupStateEnv({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const result = await command();

      expect(result).toMatchObject({ noChanges: false, pushed: false, pushWarning: warning });
      expect(result.commit).toMatch(/^[a-f0-9]{40}$/u);
      expect(await readBackupRunFreshness(process.env)).toMatchObject({
        latest: { status: "ok", kind: "git", pushFailed: true, error: warning },
        latestOk: { status: "ok", kind: "git", pushFailed: true, error: warning },
      });
    });
    expect((await executeGitCommand(remotePath, ["show-ref"])).code).not.toBe(0);
  },
);

it("redacts credential-bearing origins in conflict errors", async () => {
  const { init } = await repositoryFixture();
  const username = ["synthetic", "origin-user"].join("-");
  const password = ["synthetic", "origin-password"].join("-");
  await init(`https://${username}:${password}@example.invalid/first`);
  const conflict = init("https://example.invalid/second");
  await expect(conflict).rejects.toThrow(
    "Git backup repository already has a different origin: https://***:***@example.invalid/first",
  );
  await expect(conflict).rejects.not.toThrow(username);
  await expect(conflict).rejects.not.toThrow(password);
});

it.each([false, true])(
  "redacts catalog credentials only for secret-excluded backups (exclude=%s)",
  async (excludeSecrets) => {
    const { source, read, dumpDatabase } = codecFixture();
    const { catalog, malformedHeaders, unusableCatalogs, scopes } = createCatalogFixture(source);
    const manifest = await dumpDatabase(excludeSecrets, { role: "agent", agentId: "main" });
    const rows = (await read("tables/cache_entries.jsonl"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const redactedCatalog = (ids: string[]) => ({
      generatedBy: "openclaw-plugin-model-catalog-v1",
      providers: { fixture: { api: "openai-completions", models: ids.map((id) => ({ id })) } },
    });
    for (const scope of scopes) {
      for (const [key, original, ids] of [
        ["fixture", catalog, ["model"]],
        [
          "malformed-headers",
          malformedHeaders,
          ["array-header", "object-header", "string-headers"],
        ],
      ] as const) {
        const row = rows.find((entry) => entry.scope === scope && entry.key === key);
        expect(row).toBeDefined();
        expect(JSON.parse(row.value_json)).toEqual(
          excludeSecrets ? redactedCatalog([...ids]) : original,
        );
      }
      for (const [index, contents] of unusableCatalogs.entries()) {
        expect(
          rows.find((entry) => entry.scope === scope && entry.key === `broken-${index}`),
        ).toEqual(
          excludeSecrets ? undefined : { scope, key: `broken-${index}`, value_json: contents },
        );
      }
    }
    expect(rows).toContainEqual({
      scope: "unrelated-cache",
      key: "keep",
      value_json: '{"value":"retained"}',
    });
    expect(manifest).toMatchObject({
      userVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
      tables: {
        cache_entries: { rows: excludeSecrets ? 5 : 5 + scopes.length * unusableCatalogs.length },
      },
    });
  },
);

it("omits secret tables and reports the restore gap", async () => {
  const { dump, read, dumpDatabase, restore } = await formatFixture();
  const manifest = await dumpDatabase();
  const secretTables = [
    "device_auth_tokens",
    "channel_pairing_requests",
    "device_pairing_join_codes",
  ];
  const schema = await read("schema.sql");
  for (const table of secretTables) {
    expect(manifest.excludedTables).toContain(table);
    expect(manifest.tables).not.toHaveProperty(table);
    expect(schema).not.toContain(table);
  }
  for (const table of secretTables.slice(1)) {
    await expect(fs.lstat(path.join(dump, "tables", `${table}.jsonl`))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
  for (const table of ["session_transcript_index_state", "session_transcript_fts_rows"]) {
    expect(manifest.tables).not.toHaveProperty(table);
  }
  const restored = await restore();
  expect(restored.excludedTables).toContain("device_auth_tokens");
  expect(restored.tables.every((table) => table.ok)).toBe(true);
  expect(restored.manifest.tables).toEqual(manifest.tables);
  if (process.platform !== "win32") {
    expect((await fs.stat(restored.targetPath)).mode & 0o777).toBe(0o600);
  }
  expectDatabaseRows(restored.targetPath, {
    "SELECT rowid FROM content_fts WHERE content_fts MATCH 'lobster'": [{ rowid: 1 }],
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('memory_vec', 'session_transcript_index_state')":
      [],
    "SELECT name FROM sqlite_schema WHERE name = 'device_auth_tokens'": [],
    "SELECT COUNT(*) AS count FROM channel_pairing_requests": [{ count: 0 }],
  });
});

it("redacts secret machine-state keys while retaining ordinary machine state", async () => {
  const root = tempRoot();
  const { stateDir, database } = createStateDatabaseFixture(root);
  const { read, dumpDatabase, restore } = codecFixture(root, database.path);
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const nodeSecret = "synthetic-node-host-gateway-secret";
  const pushSecret = "synthetic-web-push-private-key";
  writeConfigMachineState("nodeHost.config", { gateway: { token: nodeSecret } }, { env });
  writeConfigMachineState("nodeHost.otherSecret", { token: nodeSecret }, { env });
  writeConfigMachineState("webPush.vapidKeys", { privateKey: pushSecret }, { env });
  const authSecret = "synthetic-shared-auth-profile-secret";
  writeConfigMachineState("authProfiles.store", { profiles: { openai: authSecret } }, { env });
  writeConfigMachineState("authProfiles.state", { active: authSecret }, { env });
  writeConfigMachineState("sidebar.sectionOrder", ["first", "second"], { env });
  closeOpenClawStateDatabaseForTest();

  const manifest = await dumpDatabase();
  const rows = await read("tables/config_machine_state.jsonl");
  const manifestJson = await read("manifest.json");

  expect(manifest).toMatchObject({
    excludedConfigStateKeyPrefixes: ["authProfiles.", "nodeHost.", "webPush.vapidKeys"],
    tables: { config_machine_state: { rows: 2 } },
  });
  const secrets = [nodeSecret, pushSecret, authSecret];
  expectText(
    rows,
    ["sidebar.sectionOrder", "first", "cron.defaultStoreKey"],
    ["nodeHost.", "webPush.vapidKeys", "authProfiles.", ...secrets],
  );
  expectText(manifestJson, [], secrets);

  const restored = await restore({ role: "global" });
  expect(restored.excludedConfigStateKeyPrefixes).toEqual([
    "authProfiles.",
    "nodeHost.",
    "webPush.vapidKeys",
  ]);
  expectDatabaseRows(restored.targetPath, {
    "SELECT state_key, value_json FROM config_machine_state ORDER BY state_key": [
      {
        state_key: "cron.defaultStoreKey",
        value_json: JSON.stringify(path.join(stateDir, "cron", "jobs.json")),
      },
      { state_key: "sidebar.sectionOrder", value_json: JSON.stringify(["first", "second"]) },
    ],
  });
});

it("rejects a restored global database without canonical ownership metadata", async () => {
  const { source, dumpDatabase, restoredPath, restore } = await formatFixture();
  withDatabase(source, (database) => {
    database.exec("DROP TABLE schema_meta;");
  });
  await dumpDatabase(false);

  await expect(restore({ role: "global" })).rejects.toThrow(
    /schema role missing; expected global/u,
  );
  await expect(fs.lstat(restoredPath)).rejects.toMatchObject({ code: "ENOENT" });
});
