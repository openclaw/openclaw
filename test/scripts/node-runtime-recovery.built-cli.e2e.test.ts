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
