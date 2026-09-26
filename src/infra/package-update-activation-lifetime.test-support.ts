import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { vi } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import {
  installPrivateUpdateHandoffStore,
  writePrivateUpdateHandoffChildGuard,
} from "../../test/helpers/private-update-handoff-store.js";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import {
  encodePackageActivationLauncher,
  openPackageActivationJournal,
  resolvePackageActivationAnchor,
  resolvePackageActivationControl,
} from "./package-update-activation-journal.js";
import { preparePackageActivationJournal } from "./package-update-activation-prepare.js";
import { packageActivationRuntimeEntrypoint } from "./package-update-activation-runtime-assets.js";
import { createPackageIntegrityReader } from "./package-update-integrity.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";
import * as runtimeWorker from "./runtime-worker-url.js";

export function createPackageActivationLifetimeFixture() {
  const lifetime = createFixtureLifetime();
  const resolveRuntimeWorkerUrl = runtimeWorker.resolveRuntimeWorkerUrl;
  let root: string;
  let childGuardEnv: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;

  function setup() {
    root = fs.realpathSync(lifetime.createTempDir("activation-lifetime-"));
    const tmp = path.join(root, "private-tmp");
    fs.mkdirSync(tmp, { mode: 0o700 });
    const { databasePath, assertDatabasePath } = installPrivateUpdateHandoffStore(tmp);
    childGuardEnv = writePrivateUpdateHandoffChildGuard(databasePath, tmp);
    const helper = path.join(root, "sealed.mjs");
    fs.writeFileSync(helper, "// inert sealed helper bytes\n");
    vi.spyOn(runtimeWorker, "resolveRuntimeWorkerUrl").mockImplementation((entry) =>
      entry.sourceWorkerName === "package-update-activation-sealed"
        ? pathToFileURL(helper)
        : resolveRuntimeWorkerUrl(entry),
    );
    return { root, assertDatabasePath, childGuardEnv };
  }

  async function prepare(cut?: (anchor: string) => void, onCustody?: (retained: boolean) => void) {
    const f = await createPackageSwapFixture(root);
    const anchor = resolvePackageActivationAnchor(f.packageRoot);
    const previous = await createPackageIntegrityReader().tree(f.packageRoot);
    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(f.packageRoot);
      cut?.(anchor);
      await preparePackageActivationJournal({
        options: { fence, nodeRunner: process.execPath, onPrepared: () => {} },
        liveRoot: f.packageRoot,
        stageRoot: f.params.stage.packageRoot,
        launcherRoot: f.params.stage.layout.binDir,
        binDir: path.dirname(f.launcher),
        previous,
        onCustody,
        launchers: [
          {
            name: "openclaw",
            previous: encodePackageActivationLauncher(
              await createPackageIntegrityReader().launcher(f.launcher),
            ),
          },
        ],
      });
    });
    return {
      ...f,
      anchor,
      operationId: openPackageActivationJournal(anchor).read().descriptor.operationId,
    };
  }

  function spawnChild(args: string[]) {
    return spawn(
      process.execPath,
      [
        ...runtimeWorker.resolveRuntimeWorkerArgv(
          resolveRuntimeWorkerUrl({
            ...packageActivationRuntimeEntrypoint,
            sourceWorkerName: "package-update-activation.process.test-support",
            distWorkerPath: "infra/package-update-activation.process.test-support.js",
          }),
        ),
        ...args,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: childGuardEnv({ ...process.env, HOME: root, USERPROFILE: root }),
      },
    );
  }

  async function stopChild(child: ChildProcess, closed: Promise<unknown>) {
    await lifetime.verifyCleanup(async () => {
      await stopChildProcess(child, 5_000);
      await closed;
    });
  }

  function killUncommittedWrite(journalPath: string) {
    const journalSetup = new DatabaseSync(journalPath);
    try {
      journalSetup.exec(`
        PRAGMA journal_mode = DELETE;
        PRAGMA synchronous = FULL;
        CREATE TABLE pressure (id INTEGER PRIMARY KEY, value TEXT NOT NULL, payload BLOB NOT NULL) STRICT;
        WITH RECURSIVE rows(id) AS (
          SELECT 1 UNION ALL SELECT id + 1 FROM rows WHERE id < 256
        )
        INSERT INTO pressure SELECT id, 'committed', zeroblob(8192) FROM rows;
      `);
    } finally {
      journalSetup.close();
    }
    return spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { DatabaseSync } from 'node:sqlite';
         const database = new DatabaseSync(process.argv[1]);
         database.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA cache_size = 2; PRAGMA cache_spill = ON; BEGIN IMMEDIATE; UPDATE package_activation SET phase = 'publication-complete'; UPDATE pressure SET value = 'uncommitted';");
         process.kill(process.pid, 'SIGKILL');`,
        journalPath,
      ],
      {
        env: childGuardEnv({ ...process.env, HOME: root, USERPROFILE: root }),
        encoding: "utf8",
        timeout: 10_000,
        killSignal: "SIGKILL",
      },
    );
  }

  function snapshotControl(anchor: string) {
    return fs
      .readdirSync(resolvePackageActivationControl(anchor))
      .toSorted()
      .map((name) => {
        const file = path.join(resolvePackageActivationControl(anchor), name);
        const stat = fs.lstatSync(file);
        return { name, ino: stat.ino, mode: stat.mode, bytes: fs.readFileSync(file) };
      });
  }

  async function writePostCoreCapability(packageRoot: string) {
    await fsp.mkdir(path.join(packageRoot, "dist/infra"), { recursive: true });
    await fsp.writeFile(
      path.join(packageRoot, "dist/infra/update-migrated-finalize.worker.js"),
      'console.log(JSON.stringify({ postCoreExecutor: "fd3-pid-start-v1", mutationProtocol: "original-cancellation-v1" }));\n',
    );
  }

  return {
    lifetime,
    setup,
    prepare,
    spawnChild,
    stopChild,
    killUncommittedWrite,
    snapshotControl,
    writePostCoreCapability,
  };
}
