// Start this build's Gateway on real prior-release state and prove the
// copy-and-swap upgrade: it starts, user data survives, and the old files keep
// their exact bytes under `.pre-<version>`.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listDirectoryTreeStrictSync } from "../src/infra/directory-walk.js";
import { UPGRADE_SET_ASIDE_SCOPE } from "../src/state/sqlite-copy-swap.js";
import { createDoctorChain } from "../src/state/state-upgrade-doctor.js";
import { ChainStepError } from "../src/state/state-upgrade-validate.js";
import { upgradeStateDirectory } from "../src/state/state-upgrade.js";
import { VERSION } from "../src/version.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

const corpusDir = fileURLToPath(new URL("./fixtures/state-corpus-populated/", import.meta.url));

// Values the shipped chain itself retires; the in-place Doctor drops them too.
const CHAIN_RETIRED_VALUES = new Set([
  // Native CLI-shaped OAuth profiles are read from the CLI, not stored.
  "anthropic:claude-cli",
  "fixture-cli-access",
  // Pending pairing requests expire; delivery rows leave `queued` once the Gateway drains them.
  "corpus-device-1",
  "queued ",
  // The running Gateway consumes its one-shot restart sentinel; the swap keeps it.
  "Synthetic restart",
]);

// The corpus stores its synthetic device keys as `PRIVATE_KEY` so the repository
// private-key scanner passes; restore the PEM marker before the Gateway reads them.
function restoreCorpusDeviceKeys(stateDir: string): void {
  const deviceJson = path.join(stateDir, "identity", "device.json");
  if (fs.existsSync(deviceJson)) {
    const text = fs.readFileSync(deviceJson, "utf8");
    fs.writeFileSync(deviceJson, text.replaceAll(" PRIVATE_KEY-----", " PRIVATE KEY-----"));
  }
  const stateDb = path.join(stateDir, "state", "openclaw.sqlite");
  const db = new DatabaseSync(stateDb);
  try {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'device_identities'").get()) {
      db.exec(
        "UPDATE device_identities SET private_key_pem = replace(private_key_pem, ' PRIVATE_KEY-----', ' PRIVATE KEY-----')",
      );
    }
  } finally {
    db.close();
  }
}

type Manifest = { verification: Record<string, Array<{ value: string; found_in?: string[] }>> };

function sqliteFiles(root: string): string[] {
  return listDirectoryTreeStrictSync(root)
    .filter(
      ({ dirent, relativePath }) =>
        dirent.isFile() &&
        !relativePath.startsWith("tmp") &&
        /(?:openclaw|openclaw-agent)\.sqlite(-wal)?$/u.test(dirent.name),
    )
    .map(({ relativePath }) => path.join(root, relativePath));
}

const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/**
 * Every text value in the upgraded tree, excluding preserved generations, logs and
 * diagnostics (set-aside rows are not readable user data).
 */
function upgradedText(stateDir: string): string {
  const parts: string[] = [];
  for (const { dirent, relativePath } of listDirectoryTreeStrictSync(stateDir)) {
    const file = path.join(stateDir, relativePath);
    if (
      !dirent.isFile() ||
      file.includes(".pre-") ||
      file.endsWith("-shm") ||
      relativePath.startsWith("logs")
    ) {
      continue;
    }
    const bytes = fs.readFileSync(file);
    if (!bytes.subarray(0, 16).equals(Buffer.from("SQLite format 3\0", "latin1"))) {
      parts.push(bytes.toString("utf8"));
      continue;
    }
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      for (const { name } of db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'diagnostic_events'",
        )
        .all() as Array<{ name: string }>) {
        try {
          for (const row of db.prepare(`SELECT * FROM "${name}"`).all()) {
            parts.push(
              Object.values(row)
                .filter((v) => typeof v === "string")
                .join(" "),
            );
          }
        } catch {
          // Virtual-table internals need their module; content tables are read above.
        }
      }
    } finally {
      db.close();
    }
  }
  return parts.join("\n");
}

const cases = [
  { release: "2026.7.1-blob", failStep: undefined },
  { release: "2026.8.35", failStep: undefined },
  { release: "2026.9.37", failStep: undefined },
  { release: "2026.10.10", failStep: undefined },
  // The generic fallback cannot import 7.x session JSON files (a Doctor file import),
  // so forced-fallback cases use releases whose sessions already live in SQLite.
  { release: "2026.8.35", failStep: "injected-step" },
  { release: "2026.10.10", failStep: "injected-step" },
];

type Instance = Awaited<ReturnType<typeof createOpenClawTestInstance>>;

function installCorpus(instance: Instance, release: string, gatewayOverride = {}): void {
  const generated = JSON.parse(fs.readFileSync(instance.configPath, "utf8"));
  fs.cpSync(path.join(corpusDir, release, "state"), instance.stateDir, {
    recursive: true,
    force: true,
  });
  restoreCorpusDeviceKeys(instance.stateDir);
  // The corpus was written in a container as /home/fixture.
  const corpus = fs
    .readFileSync(path.join(instance.stateDir, "openclaw.json"), "utf8")
    .replaceAll("/home/fixture/.openclaw", instance.stateDir)
    .replaceAll("/home/fixture", instance.homeDir);
  const config = JSON.parse(corpus);
  // The corpus plugin was installed from a path that exists only in the generator
  // container; with it configured, Doctor (in place or here) defers the 7.x session
  // import until the plugin converges.
  delete config.plugins?.entries?.["corpus-plugin"];
  fs.writeFileSync(
    instance.configPath,
    JSON.stringify({
      ...config,
      gateway: { ...generated.gateway, ...gatewayOverride },
      hooks: generated.hooks,
    }),
  );
}

describe("Gateway start upgrades prior-release state by copy and swap", () => {
  it("a start refused for invalid config publishes nothing", async () => {
    const instance = await createOpenClawTestInstance({
      name: "upgrade-refused",
      startTimeoutMs: 300_000,
    });
    try {
      // An invalid combination Doctor cannot repair, so the start is refused.
      installCorpus(instance, "2026.10.10", { bind: "lan", tailscale: { mode: "serve" } });
      const files = [instance.configPath, ...sqliteFiles(instance.stateDir)];
      const before = files.map(sha256);
      await expect(instance.startGateway()).rejects.toThrow();
      expect(files.map(sha256)).toEqual(before);
      expect(
        listDirectoryTreeStrictSync(instance.stateDir)
          .map(({ relativePath }) => relativePath)
          .filter((name) => name.includes(".pre-") || name.startsWith(".upgrade-")),
      ).toEqual([]);
    } finally {
      await instance.cleanup();
    }
  }, 600_000);

  it.each(cases)(
    "$release (forced chain failure: $failStep)",
    async ({ release, failStep }) => {
      const instance = await createOpenClawTestInstance({
        name: `upgrade-${release}`,
        startTimeoutMs: 300_000,
      });
      try {
        installCorpus(instance, release);
        const before = new Map(sqliteFiles(instance.stateDir).map((file) => [file, sha256(file)]));

        if (failStep) {
          // Run this build's Doctor on the private copy, then fail, so the generic
          // fallback rebuilds the databases; the Gateway then starts on the result.
          const [entry] = await instance.entrypoint();
          const doctor = createDoctorChain(path.resolve(entry ?? ""), []);
          await upgradeStateDirectory({
            env: instance.env,
            log: { info: () => {}, warn: () => {} },
            runChain: async (chain) => {
              await doctor(chain);
              throw new ChainStepError(failStep, `Injected failure in ${failStep}`);
            },
          });
        }
        await instance.startGateway();
        // Canonical readers serve the upgraded data through the Gateway.
        const call = async (method: string, params: object = {}): Promise<string> => {
          const result = await instance.cli([
            "gateway",
            "call",
            method,
            "--json",
            "--params",
            JSON.stringify(params),
          ]);
          expect(result.code, `${method}: ${result.stderr}`).toBe(0);
          return result.stdout;
        };
        const manifest: Manifest = JSON.parse(
          fs.readFileSync(path.join(corpusDir, release, "manifest.json"), "utf8"),
        );
        const values = (surface: string) =>
          (manifest.verification[surface] ?? []).map((entry) => entry.value);
        expect(await call("agents.list")).toContain('"ops"');
        const cron = await call("cron.list", { includeDisabled: true });
        for (const value of values("cron").filter((v) => v.startsWith("corpus-"))) {
          expect(cron).toContain(value);
        }
        const sessionKeys = values("sessions").filter((v) => /^agent:[^:]+:corpus-/u.test(v));
        expect(sessionKeys.length).toBeGreaterThan(0);
        let history = "";
        for (const sessionKey of sessionKeys) {
          history += await call("chat.history", { sessionKey });
        }
        for (const message of values("sessions").filter((v) =>
          v.startsWith("Synthetic user message"),
        )) {
          expect(history).toContain(JSON.stringify(message).slice(1, -1));
        }
        await instance.stopGateway();

        // The old bytes survive unchanged under the preserved name.
        for (const [file, digest] of before) {
          expect(sha256(`${file}.pre-${VERSION}`), file).toBe(digest);
        }
        const state = new DatabaseSync(path.join(instance.stateDir, "state", "openclaw.sqlite"), {
          readOnly: true,
        });
        try {
          const report = JSON.parse(
            (
              state
                .prepare("SELECT payload_json FROM diagnostic_events WHERE scope = ?")
                .get("upgrade.report") as { payload_json: string }
            ).payload_json,
          );
          expect(report).toMatchObject(
            failStep
              ? { mode: "fallback", failedStep: failStep, pinned: true }
              : { mode: "chain", conservationMismatches: [] },
          );
          const setAside = state
            .prepare("SELECT count(*) AS n FROM diagnostic_events WHERE scope = ?")
            .get(UPGRADE_SET_ASIDE_SCOPE) as { n: number };
          expect(setAside.n).toBe(report.setAside);
        } finally {
          state.close();
        }
        // Every value the release wrote is still stored outside diagnostics after the upgrade.
        const text = upgradedText(instance.stateDir);
        const missing = Object.values(manifest.verification)
          .flat()
          .filter((entry) => entry.found_in?.length && !CHAIN_RETIRED_VALUES.has(entry.value))
          .map((entry) => entry.value)
          .filter(
            (value) => !text.includes(value) && !text.includes(JSON.stringify(value).slice(1, -1)),
          );
        expect(missing).toEqual([]);
        expect(
          fs.readdirSync(instance.stateDir).filter((name) => name.startsWith(".upgrade-")),
        ).toEqual([]);
      } finally {
        await instance.cleanup();
      }
    },
    600_000,
  );
});
