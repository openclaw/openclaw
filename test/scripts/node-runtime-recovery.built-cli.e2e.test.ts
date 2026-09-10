import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../helpers/openclaw-test-instance.js";

const instances: OpenClawTestInstance[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.cleanup()));
});

it("recovers legacy dist/index.js Doctor before refusing its unsupported Node", async () => {
  const instance = await createOpenClawTestInstance({ name: "legacy-doctor-node-recovery" });
  instances.push(instance);
  const bin = path.join(instance.homeDir, "supported", "bin");
  const node = path.join(bin, process.platform === "win32" ? "node.exe" : "node");
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(node, "synthetic runtime; execution is mocked");
  const preload = path.join(instance.homeDir, "unsupported-node.mjs");
  const calls = path.join(instance.homeDir, "reexec.json");
  await fs.writeFile(
    preload,
    `import childProcess from "node:child_process";
     import { EventEmitter } from "node:events";
     import fs from "node:fs";
     import { syncBuiltinESMExports } from "node:module";
     Object.defineProperty(process.versions, "node", { value: "22.23.2" });
     Object.defineProperty(process, "execPath", { value: ${JSON.stringify(path.join(instance.homeDir, "legacy", "node"))} });
     process.env.PATH = ${JSON.stringify(bin)};
     childProcess.spawnSync = (command, args) => ({
       status: command === ${JSON.stringify(node)} && args[0] === "-e" ? 0 : 1,
       stdout: JSON.stringify({ version: "24.19.0", probe: { available: true, version: "3.53.4", text: true, blob: true, json: true } }),
     });
     childProcess.spawn = (command, args, options) => {
       fs.writeFileSync(${JSON.stringify(calls)}, JSON.stringify({ command, args, stdio: options.stdio, marker: options.env.OPENCLAW_NODE_UPDATE_RESPAWNED }));
       const child = new EventEmitter();
       child.kill = () => true;
       setImmediate(() => child.emit("exit", 23, null));
       return child;
     };
     syncBuiltinESMExports();`,
  );
  instance.env.NODE_OPTIONS = `--import=${pathToFileURL(preload).href}`;
  delete instance.env.OPENCLAW_NODE_UPDATE_RESPAWNED;
  const result = await instance.cli(["doctor", "--non-interactive", "--fix"]);
  expect(result.code, result.stdout + result.stderr).toBe(23);
  expect(JSON.parse(await fs.readFile(calls, "utf8"))).toMatchObject({
    command: node,
    args: [
      expect.stringMatching(/dist[/\\]index\.(?:m?js)$/),
      "doctor",
      "--non-interactive",
      "--fix",
    ],
    stdio: "inherit",
    marker: "1",
  });
  expect(result.stderr).not.toContain("Upgrade Node and re-run");
}, 60_000);

it.each([
  { name: "rejects workspace NVM_DIR before probing a sibling executable", source: "workspace" },
  { name: "honors inherited NVM_DIR without forwarding workspace roots", source: "inherited" },
  { name: "rejects workspace PATH before runtime discovery", source: "path" },
  { name: "checks launcher admission before loading workspace dotenv", source: "launcher" },
  { name: "keeps workspace roots out of compile-cache respawns", source: "compile-cache" },
  { name: "keeps workspace roots out of startup-environment respawns", source: "startup-env" },
])(
  "$name",
  async ({ source }) => {
    const instance = await createOpenClawTestInstance({ name: `runtime-env-${source}` });
    instances.push(instance);
    const workspace = path.join(instance.homeDir, "checkout");
    const manager = path.join(instance.homeDir, "sibling-nvm");
    const bin = path.join(manager, "versions/node/v24.19.0/bin");
    const node = path.join(bin, "node");
    const workspaceFnm = path.join(instance.homeDir, "workspace-fnm");
    await fs.mkdir(workspace);
    await fs.mkdir(bin, { recursive: true });
    await fs.mkdir(path.join(manager, "alias"));
    await fs.writeFile(path.join(manager, "alias/default"), "24");
    await fs.writeFile(node, "synthetic executable; process boundary is instrumented");
    await fs.writeFile(
      path.join(workspace, ".env"),
      `${source === "path" ? "PATH" : "NVM_DIR"}=${source === "path" ? bin : manager}\nFNM_DIR=${workspaceFnm}\n`,
    );
    const report = path.join(instance.homeDir, "runtime-env-report.json");
    const preload = path.join(instance.homeDir, "runtime-env-preload.mjs");
    const startupRespawn = source === "compile-cache" || source === "startup-env";
    await fs.writeFile(
      preload,
      `import childProcess from "node:child_process";
     import { EventEmitter } from "node:events";
     import fs from "node:fs";
     import { syncBuiltinESMExports } from "node:module";
     const result = { probes: [] };
     Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(startupRespawn ? "22.23.2" : "20.0.0")} });
     if (process.versions.node.startsWith("20.")) {
       const getBuiltinModule = process.getBuiltinModule;
       process.getBuiltinModule = (name) => name === "node:sqlite" ? undefined : getBuiltinModule(name);
     }
     childProcess.spawnSync = (command) => {
       result.probes.push(command);
       return {
         status: command === ${JSON.stringify(node)} ? 0 : 1,
         stdout: JSON.stringify({ version: "24.19.0", probe: { available: true, version: "3.53.4", text: true, blob: true, json: true } }),
       };
     };
     childProcess.spawn = (command, args, options) => {
       result.child = { command, args, nvm: options.env.NVM_DIR, fnm: options.env.FNM_DIR,
         marker: options.env.OPENCLAW_NODE_UPDATE_RESPAWNED,
         cacheMarker: options.env.OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED,
         startupMarker: options.env.OPENCLAW_NODE_OPTIONS_READY };
       const child = new EventEmitter();
       child.kill = () => true;
       setImmediate(() => child.emit("exit", 23, null));
       return child;
     };
     process.on("exit", () => fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({
       ...result, loadedNvm: process.env.NVM_DIR, loadedPath: process.env.PATH,
     })));
     syncBuiltinESMExports();`,
    );
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(preload).href,
        path.resolve(source === "launcher" ? "openclaw.mjs" : "dist/entry.js"),
        ...(startupRespawn ? ["update", "status"] : ["doctor", "--non-interactive", "--fix"]),
      ],
      {
        cwd: workspace,
        env: {
          ...instance.env,
          HOME: instance.homeDir,
          PATH: "",
          NVM_DIR: source === "inherited" ? manager : undefined,
          FNM_DIR: undefined,
          VOLTA_HOME: undefined,
          NODE_OPTIONS: undefined,
          NODE_DISABLE_COMPILE_CACHE: source === "compile-cache" ? undefined : "1",
          NODE_COMPILE_CACHE:
            source === "compile-cache" ? path.join(instance.homeDir, "compile-cache") : undefined,
          OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED: undefined,
          OPENCLAW_NODE_UPDATE_RESPAWNED: undefined,
          OPENCLAW_NODE_OPTIONS_READY: undefined,
          OPENCLAW_NO_RESPAWN: startupRespawn ? undefined : "1",
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    const observed = JSON.parse(await fs.readFile(report, "utf8"));
    if (source === "inherited") {
      expect(result.status, result.stdout + result.stderr).toBe(23);
      expect(observed.probes).toContain(node);
      expect(observed.child).toMatchObject({ command: node, nvm: manager, marker: "1" });
      expect(observed.child.fnm).toBeUndefined();
    } else {
      expect(observed.probes).not.toContain(node);
      expect(observed.loadedNvm).toBe(
        source === "path" || source === "launcher" ? undefined : manager,
      );
      if (startupRespawn) {
        expect(result.status, result.stdout + result.stderr).toBe(23);
        expect(observed.child.nvm).toBeUndefined();
        expect(observed.child.fnm).toBeUndefined();
        if (source === "compile-cache") {
          expect(observed.child.cacheMarker).toBe("1");
        } else if (process.platform === "win32") {
          expect(observed.child.args).toContain("--stack-size=8192");
        } else {
          expect(observed.child.startupMarker).toBe("1");
        }
      } else {
        expect(result.status, result.stdout + result.stderr).toBe(1);
        expect(observed.child).toBeUndefined();
      }
    }
    expect(observed.loadedPath).toBe("");
  },
  60_000,
);
