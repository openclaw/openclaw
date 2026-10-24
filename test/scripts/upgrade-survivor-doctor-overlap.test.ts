import { EventEmitter, once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { describe, expect } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createCommandTest } from "../helpers/command-fixture.js";

const it = createCommandTest();
const node = resolveTestNodeExecPath();
const runner = readFileSync("scripts/e2e/lib/upgrade-survivor/run.sh", "utf8");
const doctor = path.resolve("scripts/e2e/lib/upgrade-survivor/formerly-bundled-plugin-doctor.mjs");
const functions = runner.slice(
  runner.indexOf("start_formerly_bundled_doctor() {"),
  runner.indexOf("assert_legacy_operator_update_noop() {"),
);
const cleanup = runner.slice(runner.indexOf("cleanup() {"), runner.indexOf("on_error() {"));

// The Docker survivor's existing strict process-tree contract is POSIX-only.
describe("survivor independent Doctor lifetime", () => {
  if (process.platform === "win32") {
    it("refuses strict background ownership where tree verification is unsupported", async ({
      command,
    }) => {
      const result = await command.run(node, [doctor, "--managed", "2026.10.3"]);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(
        "Strict managed process-tree verification is not supported on Windows",
      );
    });
    return;
  }
  it("waits for nested registry admission before using its child and log descriptor", async ({
    command,
  }) =>
    command.lifetime.run(async () => {
      const root = command.createTempDir("survivor-doctor-registry-");
      const source = readFileSync(doctor, "utf8");
      const registryStart = source.slice(
        source.indexOf("let registry;"),
        source.indexOf("  for (let attempt = 0; !fs.existsSync(portFile)"),
      );
      const registryEnd = source.slice(source.lastIndexOf("} finally {"));
      const registryScript = path.join(root, "plugins", "npm-registry-server.mjs");
      mkdirSync(path.dirname(registryScript), { recursive: true });
      writeFileSync(registryScript, 'console.log("registry descriptor survived");\n');
      const proof = path.join(root, "proof", "doctor.mjs");
      mkdirSync(path.dirname(proof));
      const owner = pathToFileURL(path.resolve("scripts/lib/managed-child-process.mts")).href;
      writeFileSync(
        proof,
        `
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runManagedCommand, terminateManagedChild } from ${JSON.stringify(owner)};
const proofRoot = ${JSON.stringify(root)};
const portFile = path.join(proofRoot, "port");
const registryLogPath = path.join(proofRoot, "registry.log");
const registryLog = fs.openSync(registryLogPath, "w");
const registryEnv = process.env;
const packageName = "@openclaw/duckduckgo-plugin";
const expectedVersion = "2026.10.3";
const publishedVersion = "2026.8.1";
const prepublishRoot = proofRoot;
const candidatePackage = { tarball: "candidate.tgz" };
const published = [{ filename: "published.tgz" }];
${registryStart}
  assert.ok(registry?.pid, "registry child was used before asynchronous admission");
  assert.equal(await registryRun, 0);
  assert.equal(fs.readFileSync(registryLogPath, "utf8"), "registry descriptor survived\\n");
${registryEnd}
`,
      );
      const supervisor = path.join(root, "supervisor.mjs");
      writeFileSync(
        supervisor,
        `import { runManagedCommand } from ${JSON.stringify(owner)};
process.exit(await runManagedCommand({ bin: process.execPath, args: [${JSON.stringify(proof)}], requireProcessTreeExit: true, waitForCleanupRelease: true }));
`,
      );
      const result = await command.run(node, [supervisor]);
      expect(result.status, result.stderr).toBe(0);
    }));
  it.for(["success", "proof-failure", "primary-failure"] as const)(
    "joins the gated proof before rollback or dependency cleanup ($0)",
    async (mode, { command, signal }) =>
      command.lifetime.run(async () => {
        const root = command.createTempDir("survivor-doctor-overlap-");
        const events = path.join(root, "events");
        const preload = path.join(root, "preload.mjs");
        const cli = path.join(root, "cli.mjs");
        const shell = path.join(root, "runner.sh");
        writeFileSync(events, "");
        writeFileSync(
          preload,
          `
import { spawnSync } from "node:child_process";
if (process.argv[1] === ${JSON.stringify(doctor)} && process.argv[2] !== "--managed") {
  const result = spawnSync(process.execPath, [process.env.FIXTURE_CLI, "cli"], {
    env: { ...process.env, NODE_OPTIONS: "" }, stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}
`,
        );
        writeFileSync(
          cli,
          `
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { createInterface } from "node:readline";
const role = process.argv[2];
const record = (event) => fs.appendFileSync(process.env.FIXTURE_EVENTS, event + "\\n");
if (role === "main") {
  fs.writeFileSync(process.env.FIXTURE_MAIN_MARKER, "main continued while Doctor was held");
} else {
  process.on("SIGTERM", () => { record(role + ":terminated"); process.exit(0); });
}
if (role === "cli" && process.env.FIXTURE_MODE === "primary-failure") {
  spawn(process.execPath, [process.argv[1], "descendant"], { stdio: "inherit" });
}
const socket = net.createConnection(Number(process.env.FIXTURE_PORT), "127.0.0.1");
socket.once("connect", () => socket.write(JSON.stringify({ role, pid: process.pid }) + "\\n"));
createInterface({ input: socket }).once("line", (line) => {
  if (role === "main") process.exit(0);
  if (role !== "cli") throw new Error("descendant must be retired by the owner");
  if (!fs.existsSync(process.env.FIXTURE_MAIN_MARKER)) throw new Error("main work never overlapped");
  record("cli:finished");
  console.log("synthetic Doctor completed with " + line);
  process.exit(Number(line));
});
`,
        );
        writeFileSync(
          shell,
          `set -euo pipefail
exec 3>&1
ARTIFACT_ROOT="$FIXTURE_ROOT"
CURRENT_PHASE=primary
candidate_version=2026.10.3
formerly_bundled_doctor_pid=""
json_event() { printf '%s:%s\\n' "$1" "$2" >>"$FIXTURE_EVENTS"; }
stop_gateway() { printf 'dependencies:stopped\\n' >>"$FIXTURE_EVENTS"; }
openclaw_e2e_stop_process() { :; }
${functions}
${cleanup}
on_exit() {
  local code="$?"
  trap - EXIT
  set +e
  cleanup
  printf '%s:%s\\n' "$code" "$CURRENT_PHASE" >"$FIXTURE_ROOT/result"
  exit "$code"
}
trap on_exit EXIT
start_formerly_bundled_doctor
node "$FIXTURE_CLI" main
if [ "$FIXTURE_MODE" = primary-failure ]; then exit 41; fi
join_formerly_bundled_doctor
printf 'rollback:started\\n' >>"$FIXTURE_EVENTS"
printf 'summary:passed\\n' >>"$FIXTURE_EVENTS"
`,
        );
        const sockets = new Map<string, Socket>();
        const connected = new EventEmitter();
        const allSockets = new Set<Socket>();
        const closed: Promise<unknown>[] = [];
        const server = createServer((socket) => {
          allSockets.add(socket);
          closed.push(
            new Promise((resolve) => {
              socket.once("close", resolve);
            }),
          );
          socket.on("error", () => {});
          createInterface({ input: socket }).once("line", (line) => {
            const { role } = JSON.parse(line) as { role: string; pid: number };
            sockets.set(role, socket);
            connected.emit(role, socket);
          });
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening", { signal });
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("missing fixture listener");
        }
        const waitFor = (role: string): Promise<Socket> =>
          sockets.has(role)
            ? Promise.resolve(sockets.get(role)!)
            : once(connected, role, { signal }).then(([socket]) => socket as Socket);
        const running = command.run("/bin/bash", [shell], {
          env: {
            ...process.env,
            PATH: `${path.dirname(node)}${path.delimiter}${process.env.PATH ?? ""}`,
            NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
            FIXTURE_ROOT: root,
            FIXTURE_EVENTS: events,
            FIXTURE_MODE: mode,
            FIXTURE_CLI: cli,
            FIXTURE_PORT: String(address.port),
            FIXTURE_MAIN_MARKER: path.join(root, "main-continued"),
          },
        });
        try {
          const [proof, main] = await Promise.all([waitFor("cli"), waitFor("main")]);
          if (mode === "primary-failure") {
            await waitFor("descendant");
          }
          expect(readFileSync(path.join(root, "main-continued"), "utf8")).toBe(
            "main continued while Doctor was held",
          );
          expect(readFileSync(events, "utf8")).toBe("formerly-bundled-doctor:started\n");
          if (mode !== "primary-failure") {
            proof.write(`${mode === "proof-failure" ? 43 : 0}\n`);
          }
          main.write("continue\n");
          const result = await running;
          const expectedExit = mode === "success" ? 0 : mode === "proof-failure" ? 43 : 41;
          expect(result.status, result.stderr).toBe(expectedExit);
          const lines = readFileSync(events, "utf8").trim().split("\n");
          expect(lines.at(-1)).toBe("dependencies:stopped");
          expect(readFileSync(path.join(root, "result"), "utf8")).toBe(
            `${expectedExit}:${mode === "proof-failure" ? "formerly-bundled-doctor" : "primary"}\n`,
          );
          if (mode === "success") {
            expect(lines).toEqual([
              "formerly-bundled-doctor:started",
              "cli:finished",
              "formerly-bundled-doctor:passed",
              "rollback:started",
              "summary:passed",
              "dependencies:stopped",
            ]);
            expect(result.stdout).toContain("synthetic Doctor completed with 0");
          } else {
            expect(lines).not.toContain("formerly-bundled-doctor:passed");
            expect(lines).not.toContain("rollback:started");
            expect(lines).not.toContain("summary:passed");
            if (mode === "primary-failure") {
              for (const role of ["cli", "descendant"]) {
                expect(lines).toContain(`${role}:terminated`);
                expect(lines.indexOf(`${role}:terminated`)).toBeLessThan(
                  lines.indexOf("dependencies:stopped"),
                );
              }
            } else {
              expect(result.stdout).toContain("synthetic Doctor completed with 43");
            }
          }
          await Promise.all(closed);
        } finally {
          for (const socket of allSockets) {
            socket.destroy();
          }
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        }
      }),
  );
});
