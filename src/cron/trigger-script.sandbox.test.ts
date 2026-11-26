import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { writeFakeContainerExecutable } from "../agents/sandbox/container-engine.scope.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createCronScriptRuntimeFixture } from "./trigger-script.test-helpers.js";

// Model a host Gateway even when the test runner itself is containerized.
vi.mock("../agents/sandbox/docker-mount-source.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/sandbox/docker-mount-source.js")>()),
  resolveDockerSourceNamespace: async () => undefined,
}));

afterEach(() => vi.unstubAllEnvs());

it.skipIf(process.platform === "win32")(
  "recovers a stopped Docker container for cached cron scripts and conditions",
  async () => {
    const state = await createOpenClawTestState({
      prefix: "cron-docker-",
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
    });
    try {
      const bin = state.path("bin");
      const socket = state.path("docker.sock");
      const engineState = state.path("docker-state.json");
      const callsPath = state.path("docker-calls.jsonl");
      const containerId = "c".repeat(64);
      const writeState = (next: { exists: boolean; running: boolean; failStart?: boolean }) =>
        fs.writeFileSync(engineState, JSON.stringify(next));
      const readState = (): Parameters<typeof writeState>[0] =>
        JSON.parse(fs.readFileSync(engineState, "utf8"));
      fs.mkdirSync(bin);
      writeState({ exists: false, running: false });

      // The two Docker transports share the same daemon state.
      await using daemon = createServer((request, response) => {
        if (request.method !== "GET" || request.url !== `/containers/${containerId}/json`) {
          response.writeHead(400).end();
          return;
        }
        const { exists, running } = readState();
        response.writeHead(exists ? 200 : 404, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            Id: containerId,
            State: { Running: running, Paused: false, Pid: running ? 1 : 0 },
          }),
        );
      });
      await once(daemon.listen(socket), "listening");

      writeFakeContainerExecutable(
        bin,
        "docker",
        String.raw`
const fs = require("node:fs");
const statePath = ${JSON.stringify(engineState)};
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const args = process.argv.slice(process.argv[2] === "--host" ? 4 : 2);
const id = ${JSON.stringify(containerId)};
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\n");
function finish(code, output = "") {
  (code ? process.stderr : process.stdout).write(output);
  process.exit(code);
}
function save() { fs.writeFileSync(statePath, JSON.stringify(state)); }
if (args[0] === "info") finish(0, "cron-fixture-daemon\n");
if (args[0] === "create") {
  if (state.exists) finish(1, "container name is already in use");
  state.exists = true;
  state.hash = args.find(arg => arg.startsWith("openclaw.configHash="))?.split("=")[1];
  state.mounts = args.flatMap((arg, i) => {
    if (arg !== "-v" && arg !== "--volume") return [];
    const [Source, Destination, mode] = args[i + 1].split(":");
    return [{Type: "bind", Source, Destination, RW: mode !== "ro"}];
  });
  save();
  finish(0, id);
}
if (args[0] === "inspect") {
  if (!state.exists) finish(1, "No such container: " + args.at(-1));
  const status = {Running: state.running, Paused: false, Pid: state.running ? 1 : 0, StartedAt: "2026-11-20T00:00:00Z"};
  if (args[2] === "{{json .State}}") finish(0, JSON.stringify(status));
  finish(0, JSON.stringify({Id: id, State: status, Labels: {"openclaw.configHash": state.hash}, ReadonlyRootfs: true, Mounts: state.mounts, Tmpfs: {}}));
}
if (args[0] === "start") {
  if (args[1] !== id || !state.exists) finish(1, "No such container: " + args[1]);
  if (state.failStart) finish(1, "fixture start failed");
  state.running = true;
  save();
  finish(0, id);
}
if (args[0] === "exec") {
  if (!state.running) finish(1, "Error response from daemon: container " + id + " is not running");
  if (args.at(-1) === "/proc/self/mountinfo") {
    finish(0, "1 0 8:1 / / rw - ext4 /dev/fixture rw\n" + state.mounts.map((m, i) => (i+2) + " 1 8:1 /bind" + i + " " + m.Destination + " rw - ext4 /dev/fixture rw\n").join(""));
  }
  if (args.at(-1)?.endsWith("printf cron-sandbox-ready")) finish(0, "cron-sandbox-ready");
}
finish(1, "Unexpected Docker fixture command: " + JSON.stringify(args));
`,
      );
      vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
      vi.stubEnv("DOCKER_HOST", `unix://${socket}`);
      vi.stubEnv("DOCKER_CONTEXT", "");
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: state.workspaceDir,
            skipBootstrap: true,
            sandbox: {
              mode: "all",
              scope: "agent",
              workspaceAccess: "rw",
              workspaceRoot: state.path("sandboxes"),
              docker: {
                image: "openclaw-sandbox:test",
                workdir: "/cron-workspace",
                user: "1000:1000",
                tmpfs: [],
              },
              prune: { idleHours: 0, maxAgeDays: 0 },
            },
          },
        },
        plugins: { enabled: false },
      };
      const runtime = createCronScriptRuntimeFixture({ config });
      const input = {
        jobId: "stopped-sandbox",
        toolsAllow: ["exec"],
        scheduledToolPolicy: { version: 1 as const, mode: "trusted" as const },
        script: `
        const result = await exec({ command: "printf cron-sandbox-ready" });
        if (result.exitCode !== 0) throw new Error(JSON.stringify(result));
        return { fire: true, state: result.aggregated };
      `,
        state: null,
      };
      const readCalls = (): string[][] =>
        fs
          .readFileSync(callsPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
      const runPayload = async () => {
        const result = await runtime.executePayload(input);
        expect(result).toMatchObject({ kind: "completed", state: "cron-sandbox-ready" });
      };
      const stop = (failStart = false) => writeState({ ...readState(), running: false, failStart });

      await runPayload();
      await runPayload();
      expect(readCalls().filter((argv) => argv.at(-1) === "/proc/self/mountinfo")).toHaveLength(1);

      stop();
      await runPayload();

      // A failed restart must prevent user code and leave the next condition able to recover.
      stop(true);
      const checkpoint = readCalls().length;
      await expect(runtime.evaluateTrigger(input)).resolves.toMatchObject({
        kind: "error",
        error: expect.stringContaining("fixture start failed"),
      });
      expect(
        readCalls()
          .slice(checkpoint)
          .filter((argv) => argv[0] === "exec"),
      ).toEqual([]);
      stop();
      await expect(runtime.evaluateTrigger(input)).resolves.toMatchObject({
        kind: "evaluated",
        fire: true,
        state: "cron-sandbox-ready",
      });

      const calls = readCalls();
      expect(calls.filter((argv) => ["create", "rm"].includes(argv[0]!))).toHaveLength(1);
      expect(calls.filter((argv) => argv[0] === "start")).toEqual(
        Array.from({ length: 4 }, () => ["start", containerId]),
      );

      // A missing ID can also signal that the daemon changed.
      writeState({ exists: false, running: false });
      await expect(runtime.executePayload(input)).resolves.toMatchObject({ kind: "error" });
      expect(
        readCalls()
          .slice(calls.length)
          .filter((argv) => ["create", "start", "exec"].includes(argv[0]!)),
      ).toEqual([]);
    } finally {
      await state.cleanup();
    }
  },
);
