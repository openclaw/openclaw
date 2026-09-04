import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  buildSystemdManagerPropertyOutput,
  buildSystemdUnitPropertyOutput,
} from "./service.test-helpers.js";

const execFileAsync = promisify(execFile);

async function runDriver(driver: string, env: NodeJS.ProcessEnv) {
  return await execFileAsync(
    process.execPath,
    [
      "--import",
      new URL("../../scripts/tsx.mjs", import.meta.url).href,
      "--input-type=module",
      "-e",
      driver,
    ],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
}

describe.skipIf(process.platform === "win32")("native control environment boundary", () => {
  it.each([
    {
      name: "explicit bus",
      uid: 1000,
      user: "target",
      sudo: "",
      bus: "explicit",
      failure: "",
      machine: false,
    },
    {
      name: "bus only",
      uid: 1000,
      user: "target",
      sudo: "",
      bus: "bus-only",
      failure: "",
      machine: false,
    },
    {
      name: "non-login bus synthesis",
      uid: 1000,
      user: "target",
      sudo: "",
      bus: "synthesize",
      failure: "",
      machine: false,
    },
    {
      name: "missing bus fallback",
      uid: 1000,
      user: "target",
      sudo: "",
      bus: "missing",
      failure: "No medium found",
      machine: true,
    },
    {
      name: "sudo to root",
      uid: 0,
      user: "root",
      sudo: "caller",
      bus: "explicit",
      failure: "",
      machine: true,
    },
    {
      name: "sudo to target user",
      uid: 1000,
      user: "target",
      sudo: "caller",
      bus: "missing",
      failure: "No medium found",
      machine: true,
    },
    {
      name: "true root with stale sudo",
      uid: 0,
      user: "root",
      sudo: "caller",
      bus: "root",
      failure: "",
      machine: false,
    },
    {
      name: "permission denial",
      uid: 1000,
      user: "target",
      sudo: "",
      bus: "missing",
      failure: "Permission denied",
      machine: false,
    },
  ])("preserves $name routing for systemctl and busctl", async (scenario) => {
    await withTempDir("openclaw-manager-route-", async (temp) => {
      const home = await fs.realpath(temp);
      const bus = scenario.bus === "root" ? "unix:path=/run/user/0/bus" : `unix:path=${home}/bus`;
      const source = {
        HOME: scenario.bus === "root" ? "/root" : home,
        PATH: home,
        USER: scenario.user,
        LOGNAME: scenario.user,
        SUDO_USER: scenario.sudo,
        XDG_RUNTIME_DIR:
          scenario.bus === "bus-only"
            ? undefined
            : scenario.bus === "missing"
              ? path.join(home, "missing-runtime")
              : scenario.bus === "root"
                ? "/run/user/0"
                : home,
        DBUS_SESSION_BUS_ADDRESS: ["missing", "synthesize"].includes(scenario.bus)
          ? undefined
          : bus,
        BOUNDARY_PARENT_ONLY: "synthetic-parent",
      };
      if (scenario.bus === "synthesize") {
        await fs.writeFile(path.join(home, "bus"), "");
      }
      const callsPath = path.join(home, "calls.jsonl");
      const expectedBus = scenario.bus === "missing" ? undefined : bus;
      for (const command of ["systemctl", "busctl"]) {
        await fs.writeFile(
          path.join(home, command),
          `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({
  command: ${JSON.stringify(command)}, args,
  canary: Object.hasOwn(process.env, "BOUNDARY_PARENT_ONLY"),
  native: process.env.PATH === ${JSON.stringify(home)} && process.env.USER === ${JSON.stringify(scenario.user)} && process.env.DBUS_SESSION_BUS_ADDRESS === ${JSON.stringify(expectedBus)},
}) + "\\n");
if (${JSON.stringify(scenario.failure)} && !args.includes("--machine")) {
  console.error("Failed to connect to bus: " + ${JSON.stringify(scenario.failure)}); process.exit(1);
}
console.log("running");
`,
          { mode: 0o700 },
        );
      }
      const driver = `
import assert from "node:assert/strict";
import { execSystemctlUser, execBusctlUser } from ${JSON.stringify(new URL("./systemd-exec.ts", import.meta.url).href)};
process.geteuid = () => ${scenario.uid};
const source = { ...process.env, XDG_RUNTIME_DIR: ${JSON.stringify(source.XDG_RUNTIME_DIR)}, DBUS_SESSION_BUS_ADDRESS: ${JSON.stringify(source.DBUS_SESSION_BUS_ADDRESS)} };
for (const execute of [execSystemctlUser, execBusctlUser]) {
  const result = await execute(source, ["status"], 5000);
  assert.equal(result.code, ${scenario.failure === "Permission denied" ? 1 : 0});
  assert.equal(result.termination, "exit");
}
`;
      await runDriver(driver, source);
      const calls = (await fs.readFile(callsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const expectedArgs = scenario.machine
        ? [
            ...(scenario.failure ? [["--user", "status"]] : []),
            [
              "--machine",
              `${scenario.uid === 0 ? scenario.sudo : scenario.user}@`,
              "--user",
              "status",
            ],
          ]
        : [["--user", "status"]];
      expect(calls).toEqual(
        ["systemctl", "busctl"].flatMap((command) =>
          expectedArgs.map((args) => ({
            command,
            args,
            canary: false,
            native: true,
          })),
        ),
      );
    });
  });

  it("keeps loginctl account and sudo routing while closing both child environments", async () => {
    await withTempDir("openclaw-linger-env-", async (temp) => {
      const home = await fs.realpath(temp);
      const callsPath = path.join(home, "calls.jsonl");
      for (const command of ["loginctl", "sudo"]) {
        await fs.writeFile(
          path.join(home, command),
          `#!${process.execPath}
require("node:fs").appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({
  command: ${JSON.stringify(command)}, args: process.argv.slice(2),
  canary: Object.hasOwn(process.env, "BOUNDARY_PARENT_ONLY"),
}) + "\\n");
console.log("Linger=yes");
`,
          { mode: 0o700 },
        );
      }
      const driver = `
import assert from "node:assert/strict";
import { mock } from "node:test";
import { readSystemdUserLingerStatus, enableSystemdUserLinger } from ${JSON.stringify(new URL("./systemd-linger.ts", import.meta.url).href)};
const realGetuid = process.getuid;
assert.deepEqual(await readSystemdUserLingerStatus({ env: { USER: "selected" } }), { user: "selected", linger: "yes" });
// Only the synchronous sudo decision is synthetic; logging must see the real filesystem owner.
mock.method(process, "getuid", () => 1000, { times: 1 });
assert.equal((await enableSystemdUserLinger({ env: { USER: "selected" }, sudoMode: "non-interactive" })).ok, true);
assert.equal(process.getuid, realGetuid);
mock.method(process, "getuid", () => 0, { times: 1 });
assert.equal((await enableSystemdUserLinger({ env: {}, user: "explicit" })).ok, true);
assert.equal(process.getuid, realGetuid);
`;
      await runDriver(driver, { HOME: home, PATH: home, BOUNDARY_PARENT_ONLY: "synthetic-parent" });
      const calls = (await fs.readFile(callsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls).toEqual([
        { command: "loginctl", args: ["show-user", "selected", "-p", "Linger"], canary: false },
        { command: "sudo", args: ["-n", "loginctl", "enable-linger", "selected"], canary: false },
        { command: "loginctl", args: ["enable-linger", "explicit"], canary: false },
      ]);
    });
  });

  it.each([false, true])(
    "preserves effective service facts with selector drift %s",
    async (selectorDrift) => {
      await withTempDir("openclaw-service-env-", async (temp) => {
        const home = await fs.realpath(temp);
        const unit = "openclaw-boundary.service";
        const unitPath = path.join(home, ".config/systemd/user", unit);
        const envFile = path.join(home, "service.env");
        const callsPath = path.join(home, "calls.jsonl");
        const env = {
          HOME: home,
          PATH: home,
          USER: "boundary-user",
          LOGNAME: "boundary-user",
          XDG_RUNTIME_DIR: home,
          DBUS_SESSION_BUS_ADDRESS: `unix:path=${home}/bus`,
          DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${home}/system-bus`,
          SYSTEMD_BUS_TIMEOUT: "2s",
          PSMODULEANALYSISCACHEPATH: path.join(home, "synthetic-module-cache"),
          OPENCLAW_SYSTEMD_UNIT: unit,
          OPENCLAW_STATE_DIR: path.join(home, "state"),
          BOUNDARY_PARENT_ONLY: "synthetic-parent",
        };
        const inline = [
          "BOUNDARY_INLINE=synthetic-inline",
          "BOUNDARY_SHARED=inline-before-file",
          "OPENCLAW_SYSTEMD_UNIT=stale-definition.service",
          `OPENCLAW_PROFILE=${selectorDrift ? "drift" : "default"}`,
        ];
        const definition = [
          "[Service]",
          "ExecStart=/usr/bin/openclaw gateway run",
          ...inline.map((entry) => `Environment=${entry}`),
          `EnvironmentFile=${envFile}`,
          "",
        ].join("\n");
        const fileContents = "BOUNDARY_FILE=synthetic-file\nBOUNDARY_SHARED=file-wins\n";
        await fs.mkdir(path.dirname(unitPath), { recursive: true });
        await fs.mkdir(env.OPENCLAW_STATE_DIR);
        await fs.mkdir(path.join(home, "system-units"));
        await fs.writeFile(unitPath, definition);
        await fs.writeFile(envFile, fileContents);
        const serviceProperties = buildSystemdManagerPropertyOutput({
          programArguments: ["/usr/bin/openclaw", "gateway", "run"],
          environment: inline,
          environmentFiles: [[envFile, false]],
        });
        const unitProperties = buildSystemdUnitPropertyOutput({ fragmentPath: unitPath });
        const record = `
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({
  command: path.basename(process.argv[1]), args,
  canaries: ["BOUNDARY_PARENT_ONLY", "BOUNDARY_INLINE", "BOUNDARY_FILE", "BOUNDARY_SHARED"].map(name => Object.hasOwn(process.env, name)),
  selectors: ["OPENCLAW_SYSTEMD_UNIT", "OPENCLAW_PROFILE", "OPENCLAW_STATE_DIR"].some(name => Object.hasOwn(process.env, name)),
  native: ${JSON.stringify(Object.entries(env).filter(([name]) => !name.startsWith("OPENCLAW_") && !name.startsWith("BOUNDARY_")))}.every(([name, value]) => process.env[name] === value),
  marker: process.env.OPENCLAW_CLI === "1",
}) + "\\n");`;
        for (const command of ["systemctl", "busctl"]) {
          await fs.writeFile(
            path.join(home, command),
            `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
${record}
if (${JSON.stringify(command)} === "busctl") {
  if (args.includes("LoadUnit")) console.log(JSON.stringify({ type: "o", data: ["/org/freedesktop/systemd1/unit/boundary"] }));
  else if (args.includes("org.freedesktop.systemd1.Unit")) console.log(${JSON.stringify(unitProperties)});
  else if (args.includes("org.freedesktop.systemd1.Service")) console.log(${JSON.stringify(serviceProperties)});
  else process.exit(91);
} else if (args.includes("--property=LoadState")) console.log("not-found");
else if (args.includes("--property=UnitPath")) console.log(${JSON.stringify(path.join(home, "system-units"))});
else if (args.includes("is-enabled")) console.log("enabled");
else if (args.includes("status")) console.log("running");
else if (args.includes("show")) console.log("Id=${unit}\\nLoadState=loaded\\nActiveState=active\\nSubState=running\\nMainPID=4242");
else process.exit(92);
`,
            { mode: 0o700 },
          );
        }
        const serviceModule = new URL("./service.ts", import.meta.url).href;
        // Only registry selection is synthetic. Real parsing, merging, subprocess
        // launch and manager responses run in a child with no inherited credentials.
        const driver = `
import assert from "node:assert/strict";
import fs from "node:fs";
import { readGatewayServiceState, resolveGatewayService } from ${JSON.stringify(serviceModule)};
Object.defineProperty(process, "platform", { value: "linux" });
let validated = false;
try {
  const state = await readGatewayServiceState(resolveGatewayService(), {
    env: process.env, requireEffective: true, timeoutMs: 10000,
    validateEnvBeforeStatusRead(env) {
      assert.equal(env.BOUNDARY_PARENT_ONLY, "synthetic-parent");
      assert.equal(env.BOUNDARY_INLINE, "synthetic-inline");
      assert.equal(env.BOUNDARY_FILE, "synthetic-file");
      assert.equal(env.BOUNDARY_SHARED, "file-wins");
      assert.equal(env.OPENCLAW_SYSTEMD_UNIT, ${JSON.stringify(unit)});
      validated = true;
      fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ command: "validate" }) + "\\n");
      if (env.OPENCLAW_PROFILE !== "default") throw new Error("selector drift");
    },
  });
  assert.equal(state.installed, true);
  assert.equal(state.loadState.status, "loaded");
  assert.equal(state.running, true);
  assert.equal(state.runtime.pid, 4242);
  assert.equal(state.env.BOUNDARY_FILE, "synthetic-file");
  assert.equal(state.env.OPENCLAW_SYSTEMD_UNIT, ${JSON.stringify(unit)});
  assert.deepEqual(state.command.environmentValueSources, {
    BOUNDARY_INLINE: "inline", BOUNDARY_SHARED: "inline-and-file",
    OPENCLAW_SYSTEMD_UNIT: "inline", OPENCLAW_PROFILE: "inline", BOUNDARY_FILE: "file",
  });
  assert.deepEqual(state.command.definitionPaths, [${JSON.stringify(unitPath)}]);
  assert.equal(state.command.environment.OPENCLAW_SYSTEMD_UNIT, "stale-definition.service");
  console.log(JSON.stringify({ outcome: "running", validated }));
} catch (error) {
  if (error.message !== "selector drift") throw error;
  console.log(JSON.stringify({ outcome: "refused", validated }));
}`;
        const { stdout } = await runDriver(driver, env);
        expect(JSON.parse(stdout)).toEqual({
          outcome: selectorDrift ? "refused" : "running",
          validated: true,
        });
        expect(await fs.readFile(unitPath, "utf8")).toBe(definition);
        expect(await fs.readFile(envFile, "utf8")).toBe(fileContents);
        const calls = (await fs.readFile(callsPath, "utf8"))
          .trim()
          .split("\n")
          .map(
            (line) =>
              JSON.parse(line) as {
                command: string;
                args: string[];
                canaries: boolean[];
                selectors: boolean;
                native: boolean;
                marker: boolean;
              },
          );
        expect(calls.slice(0, 4).map((call) => call.command)).toEqual([
          "busctl",
          "busctl",
          "busctl",
          "validate",
        ]);
        expect(calls[0]?.args).toEqual([
          "--user",
          "--json=short",
          "call",
          "org.freedesktop.systemd1",
          "/org/freedesktop/systemd1",
          "org.freedesktop.systemd1.Manager",
          "LoadUnit",
          "s",
          unit,
        ]);
        if (selectorDrift) {
          expect(calls).toHaveLength(4);
        } else {
          expect(calls.filter((call) => call.command === "busctl")).toHaveLength(6);
          expect(
            calls.some((call) => call.command === "systemctl" && call.args.includes("is-enabled")),
          ).toBe(true);
          expect(
            calls.some((call) => call.command === "systemctl" && call.args.includes("status")),
          ).toBe(true);
          expect(
            calls.some(
              (call) => call.command === "systemctl" && call.args.includes("--property=LoadState"),
            ),
          ).toBe(true);
          expect(
            calls.some(
              (call) =>
                call.command === "systemctl" &&
                call.args.includes("show") &&
                call.args.includes(unit),
            ),
          ).toBe(true);
        }
        for (const call of calls.filter((candidate) => candidate.command !== "validate")) {
          expect(call, `${call.command} ${call.args.join(" ")}`).toMatchObject({
            canaries: [false, false, false, false],
            selectors: false,
            native: true,
            marker: true,
          });
        }
      });
    },
  );
});
