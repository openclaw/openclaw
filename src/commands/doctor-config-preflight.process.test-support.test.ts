import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { getCliProcessTestTimeout } from "../cli/cli-process-child.test-helpers.js";
import { buildCliRespawnPlan } from "../entry.respawn.js";
import {
  createSourceRuntime,
  runBuiltRuntime,
  runIsolatedModuleScript,
} from "./doctor-config-preflight.process.test-support.js";

const tempDirs = createFixtureLifetime();
afterEach(() => tempDirs.cleanup());
const DIAGNOSTIC_CHILD_TIMEOUT_MS = 1_000;

function createRuntime(source: string): string {
  const runtimeRoot = tempDirs.createTempDir("openclaw-doctor-child-diagnostics-");
  fs.mkdirSync(path.join(runtimeRoot, "dist"));
  fs.writeFileSync(path.join(runtimeRoot, "package.json"), '{"type":"module"}\n');
  fs.writeFileSync(path.join(runtimeRoot, "dist", "entry.js"), source);
  return runtimeRoot;
}

describe("Doctor runtime child diagnostics", () => {
  it("preserves normal output, command arguments, exit status, and caller runtime policy", async () => {
    const runtimeRoot = createRuntime(`
      console.log(JSON.stringify({
        args: process.argv.slice(2),
        maglevDisabled: process.execArgv.includes("--no-maglev"),
        symlinksPreserved: process.execArgv.includes("--preserve-symlinks"),
        cwd: process.cwd(),
      }));
      console.error("validation diagnostic");
      process.exitCode = 7;
    `);
    const result = await tempDirs.track(
      runBuiltRuntime(
        runtimeRoot,
        { PATH: process.env.PATH },
        ["config", "validate", "--json"],
        5_000,
      ),
    );

    expect(result).toEqual({
      code: 7,
      signal: null,
      stdout: `${JSON.stringify({
        args: ["config", "validate", "--json"],
        maglevDisabled: false,
        symlinksPreserved: true,
        cwd: runtimeRoot,
      })}\n`,
      stderr: "validation diagnostic\n",
    });
  });

  it("starts the owned child with its CLI warning and stack policy already configured", async () => {
    const runtimeRoot = createRuntime(
      "console.log(JSON.stringify({ argv: process.argv, execArgv: process.execArgv, execPath: process.execPath }));",
    );
    const env = { PATH: process.env.PATH };
    const result = await tempDirs.track(
      runBuiltRuntime(runtimeRoot, env, ["update", "--json"], 5_000),
    );
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    const launch = JSON.parse(result.stdout) as {
      argv: string[];
      execArgv: string[];
      execPath: string;
    };
    expect(launch.argv.slice(2)).toEqual(["update", "--json"]);
    // Exercise the real startup decision against the flags the native child received.
    expect(buildCliRespawnPlan({ ...launch, env, autoNodeExtraCaCerts: "" })).toBeNull();
  });

  it("preserves the combined UTF-8 output limit without charging diagnostic readiness", async () => {
    const runtimeRoot = createRuntime('process.stdout.write("éé"); process.stderr.write("xxxx");');
    const env = { PATH: process.env.PATH };
    const result = await tempDirs.track(runBuiltRuntime(runtimeRoot, env, [], 5_000, 8));
    expect(result).toEqual({ code: 0, signal: null, stdout: "éé", stderr: "xxxx" });
    await expect(tempDirs.track(runBuiltRuntime(runtimeRoot, env, [], 5_000, 7))).rejects.toThrow(
      "CLI process exceeded maxBuffer (7 bytes)",
    );
  });

  it.skipIf(process.platform === "win32" || Boolean(process.versions.bun))(
    "reports the retained timer after a built child prints its final output",
    async () => {
      const runtimeRoot = createRuntime(
        'console.log("validation finished"); setInterval(() => {}, 1_000);',
      );
      const failure = await Promise.resolve()
        .then(() =>
          tempDirs.track(
            runBuiltRuntime(
              runtimeRoot,
              { PATH: process.env.PATH },
              [],
              DIAGNOSTIC_CHILD_TIMEOUT_MS,
            ),
          ),
        )
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      const message = String(failure);
      expect(message).toContain("1000ms deadlock guard");
      expect(message).toContain("validation finished");
      expect(message).toContain('"Timeout":1');
      expect(message).toContain('"activeHandles"');
      const report = message
        .split("--- Node diagnostic report ---\n")[1]
        ?.split("\n--- child diagnostics ---")[0];
      expect(JSON.parse(report ?? "null")).toMatchObject({
        libuv: expect.arrayContaining([
          expect.objectContaining({ type: "timer", is_active: true, is_referenced: true }),
        ]),
      });
    },
    getCliProcessTestTimeout(DIAGNOSTIC_CHILD_TIMEOUT_MS),
  );
});

// Exercise module and built-runtime completion with real held SQLite locks.
describe.each(["module", "built"] as const)("Doctor %s child lifetime", (runtime) => {
  it.each([0, 7])("joins native main and Worker claims before returning exit %s", async (code) => {
    const root = tempDirs.createTempDir("openclaw-doctor-module-lifetime-");
    const runtimeRoot = createSourceRuntime(root);
    const databasePaths = [path.join(root, "main.sqlite"), path.join(root, "worker.sqlite")];
    const ownershipUrl = pathToFileURL(path.resolve("src/infra/vitest-resource-ownership.ts")).href;
    const openClaimedDatabase = `
      import { DatabaseSync } from "node:sqlite";
      import { getVitestResourceContext } from ${JSON.stringify(ownershipUrl)};
      const context = getVitestResourceContext();
      if (context?.kind !== "owned") throw new Error("Expected validated child owner");
      for (const owner of context.owners) owner.claimNativeHandle(() => {});
    `;
    const workerSource = `
      import { parentPort, threadId } from "node:worker_threads";
      ${openClaimedDatabase}
      const database = new DatabaseSync(${JSON.stringify(databasePaths[1])});
      database.exec("BEGIN EXCLUSIVE");
      parentPort.postMessage(threadId);
      setInterval(() => {}, 1000);
    `;
    const env = { PATH: process.env.PATH, TSX_DISABLE_CACHE: "1" };
    const before = { ...env };
    const script = `
          import { once } from "node:events";
          import { Worker } from "node:worker_threads";
          ${openClaimedDatabase}
          const database = new DatabaseSync(${JSON.stringify(databasePaths[0])});
          database.exec("BEGIN EXCLUSIVE");
          const worker = new Worker(new URL(${JSON.stringify("data:text/javascript," + encodeURIComponent(workerSource))}), {execArgv: ["--import", "tsx"]});
          const [threadId] = await once(worker, "message");
          console.log(JSON.stringify({pid: process.pid, threadId, owners: context.owners.map(({root, identity}) => ({root, identity}))}));
          console.error("native child diagnostic");
          process.exit(${code});
        `;
    if (runtime === "built") {
      fs.writeFileSync(path.join(runtimeRoot, "dist", "entry.js"), script);
    }
    const execution = tempDirs.track(
      runtime === "built"
        ? runBuiltRuntime(runtimeRoot, env, [], 30_000)
        : runIsolatedModuleScript(env, script, { runtimeRoot }),
    );
    const result = await execution.catch((error: unknown) => {
      expect(code).toBe(7);
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ code, stderr: "native child diagnostic\n" });
      return error as Error & { stdout: string; stderr: string };
    });
    if (runtime === "built") {
      expect(result, `${result.stdout}\n${result.stderr}`).toMatchObject({ code, signal: null });
    } else if (code === 0) {
      expect(result).not.toBeInstanceOf(Error);
    } else {
      expect(result).toBeInstanceOf(Error);
    }
    expect(result.stderr).toBe("native child diagnostic\n");
    expect(env).toEqual(before);
    const { pid, threadId, owners } = JSON.parse(result.stdout) as {
      pid: number;
      threadId: number;
      owners: { root: string; identity: string }[];
    };
    expect(threadId).toBeGreaterThan(0);
    expect(owners.length).toBeGreaterThan(0);
    for (const owner of owners) {
      const claims = path.join(owner.root, ".vitest-resource-owner", "claims");
      const receipts = fs.readdirSync(claims).flatMap((id) => {
        const file = path.join(claims, id, "native-worker");
        if (!fs.existsSync(file)) {
          return [];
        }
        const claimant = fs.readFileSync(file, "utf8");
        if (claimant !== `${pid}:0` && claimant !== `${pid}:${threadId}`) {
          return [];
        }
        expect(fs.existsSync(path.join(claims, id, "released"))).toBe(false);
        expect(fs.readFileSync(path.join(claims, id, "native-exited"), "utf8")).toBe(
          `${owner.identity}:${id}:${claimant}`,
        );
        return [claimant];
      });
      expect(receipts.toSorted()).toEqual([`${pid}:0`, `${pid}:${threadId}`].toSorted());
    }
    for (const databasePath of databasePaths) {
      const database = new DatabaseSync(databasePath);
      try {
        database.exec("BEGIN EXCLUSIVE; ROLLBACK");
      } finally {
        database.close();
      }
    }
  });
});
