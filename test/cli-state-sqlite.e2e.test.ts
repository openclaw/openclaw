import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { requireGitCommand as requireGit } from "../src/infra/git-exec.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
} from "../src/state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../src/state/openclaw-state-db.js";

function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [path.resolve("openclaw.mjs"), ...args], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
}

const runDoctorCli = (args: string[], env: NodeJS.ProcessEnv) => runCli(["doctor", ...args], env);

function cliEnv(tempHome: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: tempHome,
    USERPROFILE: tempHome,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_STATE_DIR: path.join(tempHome, ".openclaw"),
    OPENCLAW_TEST_FAST: "1",
  };
  delete env.OPENCLAW_CONFIG_PATH;
  delete env.OPENCLAW_HOME;
  delete env.VITEST;
  return { ...env, ...overrides };
}

function withCliHome(
  prefix: string,
  exercise: (tempHome: string, stateDir: string, env: NodeJS.ProcessEnv) => Promise<void>,
) {
  return withTempHome(
    (tempHome) => exercise(tempHome, path.join(tempHome, ".openclaw"), cliEnv(tempHome)),
    { prefix },
  );
}

function seedCommittedWal(database: Pick<ReturnType<typeof openOpenClawStateDatabase>, "db">) {
  database.db.exec(`
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE compact_sidecar_payload (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
    PRAGMA wal_checkpoint(TRUNCATE);
    INSERT INTO compact_sidecar_payload (payload) VALUES ('committed wal frame');
  `);
}

function expectRejected(result: ReturnType<typeof runDoctorCli>, reason: string) {
  expect(result.status).not.toBe(0);
  expect(`${result.stderr}\n${result.stdout}`).toContain(reason);
}

function credentialFixture(scope: string, resource: string) {
  const secrets = ["user", "password", "query"].map((kind) => `synthetic-${scope}-${kind}`);
  const [username, password, query] = secrets;
  return {
    secrets,
    url: `https://${username}:${password}@example.invalid/${resource}?access_token=${query}`,
  };
}

function expectRedacted(output: string, secrets: string[], resource: string) {
  expect(output).toContain(`https://***:***@example.invalid/${resource}?access_token=***`);
  for (const secret of secrets) {
    expect(output).not.toContain(secret);
  }
}

describe("SQLite CLI maintenance ownership", () => {
  it("compacts after full CLI startup without retaining a config-health database handle", async () => {
    await withCliHome("openclaw-state-sqlite-cli-", async (_tempHome, stateDir, env) => {
      try {
        const database = openOpenClawStateDatabase({ env });
        database.db.exec(`
            CREATE TABLE compact_cli_payload (
              id INTEGER PRIMARY KEY,
              payload TEXT NOT NULL
            );
            BEGIN IMMEDIATE;
          `);
        const insert = database.db.prepare("INSERT INTO compact_cli_payload (payload) VALUES (?)");
        for (let index = 0; index < 256; index += 1) {
          insert.run(`${index}:${"x".repeat(8_192)}`);
        }
        database.db.exec(`
            COMMIT;
            DELETE FROM compact_cli_payload;
            PRAGMA wal_checkpoint(TRUNCATE);
          `);
      } finally {
        closeOpenClawStateDatabase();
      }

      const result = runDoctorCli(["--state-sqlite", "compact", "--json"], env);

      expect(result.status, result.stderr || result.stdout).toBe(0);
      const report = JSON.parse(result.stdout.trim()) as { before: { freelistPages: number } };
      expect(report).toMatchObject({
        after: { autoVacuum: 2, freelistPages: 0 },
        integrityCheck: "ok",
        skipped: false,
      });
      expect(report.before.freelistPages).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(true);
    });
  }, 90_000);

  describe.each(["shared-state", "configured-session"] as const)(
    "%s sidecar ownership",
    (owner) => {
      it.skipIf(owner === "shared-state" && process.platform === "win32")(
        "rejects hard-linked WALs before destructive maintenance",
        async () => {
          await withCliHome("openclaw-sidecar-cli-", async (tempHome, stateDir, baseEnv) => {
            const shared = owner === "shared-state";
            const storePath = path.join(tempHome, "external-sessions", "sessions.json");
            const sqlitePath = path.join(path.dirname(storePath), "openclaw-agent.sqlite");
            const configPath = path.join(stateDir, "openclaw.json");
            if (!shared) {
              fs.mkdirSync(path.dirname(storePath), { recursive: true });
              fs.mkdirSync(stateDir, { recursive: true });
              fs.writeFileSync(storePath, "{}\n", "utf8");
              fs.writeFileSync(
                configPath,
                JSON.stringify({ session: { store: storePath } }),
                "utf8",
              );
            }
            const env = shared ? baseEnv : { ...baseEnv, OPENCLAW_CONFIG_PATH: configPath };
            const database = shared
              ? openOpenClawStateDatabase({ env })
              : openOpenClawAgentDatabase({ agentId: "main", env, path: sqlitePath });
            const externalWalPath = path.join(
              tempHome,
              "external-alias",
              path.basename(database.path) + "-wal",
            );
            try {
              seedCommittedWal(database);
              fs.mkdirSync(path.dirname(externalWalPath), { recursive: true });
              fs.linkSync(`${database.path}-wal`, externalWalPath);
              const before = fs.readFileSync(externalWalPath);
              expect(before.byteLength).toBeGreaterThan(0);
              expectRejected(
                runDoctorCli(
                  [shared ? "--state-sqlite" : "--session-sqlite", "compact", "--json"],
                  env,
                ),
                "hard-linked path",
              );
              expect(fs.readFileSync(externalWalPath)).toEqual(before);
            } finally {
              if (shared) {
                closeOpenClawStateDatabase();
              } else {
                closeOpenClawAgentDatabaseByPath(sqlitePath);
              }
            }
          });
        },
        90_000,
      );
    },
  );

  it("rejects destructive explicit session stores outside the active state owner", async () => {
    await withCliHome("openclaw-session-sqlite-cli-", async (tempHome, _stateDir, env) => {
      const externalStorePath = path.join(
        tempHome,
        "external-state/agents/main/sessions/sessions.json",
      );

      const result = runDoctorCli(
        ["--session-sqlite", "compact", "--session-sqlite-store", externalStorePath, "--json"],
        env,
      );

      expectRejected(result, "outside the active OpenClaw state directory");
      expect(fs.existsSync(externalStorePath)).toBe(false);
    });
  }, 90_000);

  describe.each(["hard", "symbolic"] as const)("%s-linked session sidecars", (link) => {
    it.skipIf(link === "symbolic" && process.platform === "win32")(
      "rejects destructive maintenance without changing the target",
      async () => {
        await withCliHome(
          "openclaw-session-sqlite-sidecar-cli-",
          async (tempHome, stateDir, env) => {
            const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
            const agentDir = path.join(stateDir, "agents", "main", "agent");
            const sqlitePath = path.join(agentDir, "openclaw-agent.sqlite");
            const targetPath =
              link === "hard"
                ? path.join(tempHome, "external-state", "openclaw-agent.sqlite-wal")
                : path.join(agentDir, "sidecar-target");
            const contents = link === "hard" ? "external wal\n" : "owned target\n";
            fs.mkdirSync(path.dirname(storePath), { recursive: true });
            fs.mkdirSync(agentDir, { recursive: true });
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.writeFileSync(storePath, "{}\n", "utf8");
            fs.writeFileSync(targetPath, contents, "utf8");
            const linkSidecar = link === "hard" ? fs.linkSync : fs.symlinkSync;
            linkSidecar(targetPath, `${sqlitePath}-wal`);
            expectRejected(
              runDoctorCli(
                ["--session-sqlite", "compact", "--session-sqlite-store", storePath, "--json"],
                env,
              ),
              `${link === "hard" ? "hard-linked" : "symbolic-link"} path`,
            );
            expect(fs.readFileSync(targetPath, "utf8")).toBe(contents);
          },
        );
      },
      90_000,
    );
  });

  it.skipIf(process.platform === "win32")(
    "keeps Git backup failures useful through the shipped CLI",
    async () => {
      const repository = fs.mkdtempSync(
        path.join(fs.realpathSync("/var/tmp"), "openclaw-backup-git-cli-"),
      );
      try {
        await withTempHome(
          async (tempHome) => {
            const remote = path.join(tempHome, "remote.git");
            const unborn = path.join(tempHome, "unborn");
            const hooks = path.join(tempHome, "hooks");
            const env = cliEnv(tempHome, {
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_TERMINAL_PROMPT: "0",
              NO_COLOR: "1",
            });

            openOpenClawStateDatabase({ env });
            closeOpenClawStateDatabase();
            await requireGit(tempHome, ["init", "--bare", remote]);

            const cli = (args: string[], childEnv: NodeJS.ProcessEnv = env) =>
              runCli(args, childEnv);
            const expectExit = (result: ReturnType<typeof runCli>, code: number) => {
              expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(code);
            };

            expectExit(
              cli(["backup", "git", "init", "--repository", repository, "--remote", remote]),
              0,
            );
            await requireGit(repository, ["config", "user.name", "OpenClaw Backup Test"]);
            await requireGit(repository, ["config", "user.email", "backup@example.invalid"]);
            fs.mkdirSync(hooks);
            const pushCredentials = credentialFixture("cli", "backup.git");
            const credentialUrl = pushCredentials.url;
            fs.writeFileSync(
              path.join(hooks, "pre-push"),
              [
                "#!/bin/sh",
                ...Array.from(
                  { length: 20 },
                  (_, index) => `printf 'stderr-old-${index} ${credentialUrl}\\n' >&2`,
                ),
                `printf 'stderr-tail-🦞 ${credentialUrl}\\n' >&2`,
                ...Array.from(
                  { length: 20 },
                  (_, index) => `printf 'stdout-old-${index} ${credentialUrl}\\n'`,
                ),
                `printf 'stdout-tail-🐚 ${credentialUrl}\\n'`,
                "exit 1",
              ].join("\n"),
              { mode: 0o700 },
            );
            await requireGit(repository, ["config", "core.hooksPath", hooks]);

            const failedPush = cli([
              "backup",
              "git",
              "create",
              "--repository",
              repository,
              "--global",
              "--push",
              "--exclude-secrets",
            ]);
            expectExit(failedPush, 0);
            const pushOutput = `${failedPush.stdout}\n${failedPush.stderr}`;
            expect(pushOutput).toContain("git push failed (code=1, termination=exit)");
            expect(pushOutput).toContain("stderr-tail-🦞");
            expect(pushOutput).toContain("stdout-tail-🐚");
            expectRedacted(pushOutput, pushCredentials.secrets, "backup.git");

            await requireGit(tempHome, ["init", unborn]);
            const emptyHistory = cli(["backup", "git", "log", "--repository", unborn]);
            expectExit(emptyHistory, 0);
            expect(emptyHistory.stdout).toContain("No Git backup commits");

            const blob = await requireGit(repository, ["hash-object", "-w", "--stdin"], {
              input: "not a commit\n",
            });
            await requireGit(repository, ["update-ref", "refs/tags/broken", blob]);
            const quarantine = path.join(repository, ".git", "quarantine");
            fs.mkdirSync(quarantine);
            fs.renameSync(
              path.join(repository, ".git", "objects", blob.slice(0, 2), blob.slice(2)),
              path.join(quarantine, blob),
            );
            await requireGit(repository, ["symbolic-ref", "HEAD", "refs/tags/broken"]);
            const historyCredentials = credentialFixture("history", "objects");
            const failedHistory = cli(
              ["backup", "git", "log", "--repository", repository, "--json"],
              {
                ...env,
                GIT_ALTERNATE_OBJECT_DIRECTORIES: `"/tmp/${historyCredentials.url}"`,
              },
            );
            expectExit(failedHistory, 1);
            const historyOutput = `${failedHistory.stdout}\n${failedHistory.stderr}`;
            expect(historyOutput).toContain(
              "git show-ref HEAD failed (code=128, termination=exit)",
            );
            expect(historyOutput).toContain("stderr:");
            expectRedacted(historyOutput, historyCredentials.secrets, "objects");
          },
          { prefix: "openclaw-backup-git-cli-" },
        );
      } finally {
        fs.rmSync(repository, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
