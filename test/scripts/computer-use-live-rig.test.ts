import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getFreePort } from "../../src/test-utils/ports.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const rigScriptSource = path.resolve("scripts/dev/computer-use-macos-live-rig.sh");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runGit(root: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
}

function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source);
  fs.chmodSync(filePath, 0o755);
}

function createRigRepository() {
  const root = tempDirs.make("openclaw-computer-use-rig-");
  const scriptsDev = path.join(root, "scripts", "dev");
  const fakeBin = path.join(root, "fake-bin");
  const app = path.join(root, "OpenClaw.app");
  const appExecutable = path.join(app, "Contents", "MacOS", "OpenClaw");
  const dirs = [scriptsDev, fakeBin, path.dirname(appExecutable), path.join(root, "home")];
  for (const directory of dirs) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const script = path.join(scriptsDev, "computer-use-macos-live-rig.sh");
  const fixture = path.join(scriptsDev, "computer-use-linux-x11-fixture.py");
  const proof = path.join(scriptsDev, "computer-use-macos-live-proof.ts");
  fs.copyFileSync(rigScriptSource, script);
  fs.chmodSync(script, 0o755);
  fs.writeFileSync(fixture, "# committed fixture\n");
  const captureInvocation = `#!${process.execPath}
console.log(JSON.stringify({
  args: process.argv.slice(2),
  config: process.env.OPENCLAW_CONFIG_PATH,
  state: process.env.OPENCLAW_STATE_DIR,
  profile: process.env.OPENCLAW_PROFILE,
  ambient: ["OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PASSWORD", "OPENCLAW_GATEWAY_URL", "OPENCLAW_GATEWAY_PORT"].filter(key => process.env[key] !== undefined),
}));
`;
  fs.writeFileSync(proof, captureInvocation);
  fs.writeFileSync(path.join(root, "scripts", "run-node.mjs"), captureInvocation);
  writeExecutable(appExecutable, captureInvocation);
  writeExecutable(path.join(fakeBin, "defaults"), '#!/bin/sh\n[ "$1" != read ]\n');
  writeExecutable(path.join(fakeBin, "uname"), "#!/bin/sh\necho Linux\n");
  for (const command of ["codesign", "xdotool", "xdpyinfo"]) {
    writeExecutable(path.join(fakeBin, command), "#!/bin/sh\nexit 0\n");
  }

  runGit(root, "init", "-q");
  runGit(root, "config", "user.name", "OpenClaw Test");
  runGit(root, "config", "user.email", "openclaw-test@example.com");
  runGit(root, "add", "scripts");
  runGit(root, "commit", "-q", "-m", "fixture");

  return { root, script, fakeBin, app, fixture, proof };
}

function runRig(params: { root: string; script: string; fakeBin: string; args: string[] }) {
  return spawnSync("bash", [params.script, ...params.args], {
    cwd: params.root,
    encoding: "utf8",
    env: {
      HOME: path.join(params.root, "home"),
      OPENCLAW_HOME: path.join(params.root, "home"),
      DISPLAY: ":99",
      XDG_SESSION_TYPE: "x11",
      PATH: `${params.fakeBin}:${process.env.PATH ?? ""}`,
      OPENCLAW_GATEWAY_TOKEN: "synthetic-ambient-token",
      OPENCLAW_GATEWAY_PASSWORD: "synthetic-ambient-password",
      OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
      OPENCLAW_GATEWAY_PORT: "18789",
    },
    timeout: 15_000,
  });
}

async function prepareRig(platform: "macos" | "linux", dirty = false) {
  const fixture = createRigRepository();
  if (dirty) {
    fs.writeFileSync(
      platform === "macos" ? fixture.proof : fixture.fixture,
      platform === "macos" ? "// locally modified proof\n" : "# locally modified fixture\n",
    );
  }
  const scratch = path.join(fixture.root, "scratch");
  const profile = "proof-test";
  const port = String(await getFreePort());
  const args =
    platform === "macos"
      ? ["prepare", profile, port, fixture.app, scratch, ...(dirty ? ["cua"] : [])]
      : ["prepare-linux", profile, port, scratch];
  const result = runRig({ ...fixture, args });
  expect(result).toMatchObject(dirty ? { status: 1 } : { stderr: "", status: 0 });
  return { ...fixture, scratch, profile, port, result };
}

describe.each(["macos", "linux"] as const)("computer-use %s live rig auth", (platform) => {
  it("generates matching private token configs for a fresh read-only CLI", async () => {
    const rig = await prepareRig(platform);
    const gatewayPath = path.join(rig.scratch, "gateway.json");
    const clientPath = path.join(rig.scratch, platform === "macos" ? "app.json" : "node.json");
    const gateway = JSON.parse(fs.readFileSync(gatewayPath, "utf8"));
    const client = JSON.parse(fs.readFileSync(clientPath, "utf8"));
    // Boolean comparisons keep generated secrets out of assertion failures.
    const token = gateway.gateway.auth.token;
    expect(typeof token === "string" && /^[a-f0-9]{64}$/.test(token)).toBe(true);
    expect(client.gateway.remote.token === token).toBe(true);
    expect(`${rig.result.stdout}${rig.result.stderr}`.includes(token)).toBe(false);
    expect(fs.readFileSync(path.join(rig.scratch, "rig.json"), "utf8").includes(token)).toBe(false);
    expect(gateway.gateway.auth.mode).toBe("token");
    expect(gateway.gateway.mode).toBe("local");
    expect(gateway.gateway.bind).toBe("loopback");
    expect(gateway.gateway.nodes.commands.allow).toEqual(["computer.act"]);
    expect(gateway.gateway.controlUi).toBeUndefined();
    expect(client.gateway.mode).toBe("remote");
    expect(client.gateway.remote.url).toBe(`ws://127.0.0.1:${rig.port}`);
    expect(fs.readdirSync(path.join(rig.scratch, "cli-state"))).toEqual([]);
    const configPaths = [gatewayPath, clientPath];
    if (platform === "macos") {
      const appConfig = path.join(rig.root, "home", `.openclaw-${rig.profile}`, "openclaw.json");
      expect(fs.readFileSync(appConfig, "utf8") === fs.readFileSync(clientPath, "utf8")).toBe(true);
      expect(gateway.gateway.nodes.pairing).toBeUndefined();
      configPaths.push(appConfig);
    } else {
      expect(gateway.gateway.nodes.pairing).toEqual({ autoApproveLocal: true, sshVerify: false });
      expect(client.plugins.entries["cua-computer"].enabled).toBe(true);
    }
    for (const configPath of configPaths) {
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    }
    const other = await prepareRig(platform);
    const otherToken = JSON.parse(fs.readFileSync(path.join(other.scratch, "gateway.json"), "utf8"))
      .gateway.auth.token;
    expect(otherToken === token).toBe(false);
  });

  it("forces token/loopback launch and rejects ambient credential and target precedence", async () => {
    const rig = await prepareRig(platform);
    const gatewayState =
      platform === "macos"
        ? path.join(rig.root, "home", `.openclaw-${rig.profile}`)
        : path.join(rig.scratch, "gateway-state");
    for (const [command, state, extra] of [
      ["gateway", gatewayState, []],
      ["nodes", path.join(rig.scratch, "cli-state"), []],
      ["approve", path.join(rig.scratch, "agent-state"), ["synthetic-request"]],
    ] as const) {
      const result = runRig({ ...rig, args: [command, rig.scratch, ...extra] });
      expect(result).toMatchObject({ stderr: "", status: 0 });
      const invocation = JSON.parse(result.stdout);
      expect(invocation.ambient).toEqual([]);
      expect(invocation.config).toBe(path.join(rig.scratch, "gateway.json"));
      expect(invocation.state).toBe(state);
      if (command === "gateway") {
        expect(invocation.args).toEqual(
          `--profile ${rig.profile} gateway run --port ${rig.port} --auth token --bind loopback --verbose`.split(
            " ",
          ),
        );
      }
    }
    const result = runRig({ ...rig, args: [platform === "macos" ? "app" : "node", rig.scratch] });
    expect(result.status).toBe(0);
    const invocation = JSON.parse(result.stdout);
    expect(invocation.ambient).toEqual([]);
    if (platform === "macos") {
      expect(invocation.profile).toBe(rig.profile);
    } else {
      expect(invocation.config).toBe(path.join(rig.scratch, "node.json"));
      expect(invocation.state).toBe(path.join(rig.scratch, "node-state"));
    }
  });
});

it.each(["macos", "linux"] as const)("rejects dirty %s runtime sources", async (platform) => {
  const { result } = await prepareRig(platform, true);
  expect(result.stderr).toContain("runtime sources are dirty");
});
