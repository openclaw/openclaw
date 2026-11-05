import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildExpectedGatewayServicePlan } from "./doctor-gateway-runtime-plan.js";

const originalArgv = process.argv;
let root: string;
afterEach(() => {
  process.argv = originalArgv;
  fs.rmSync(root, { recursive: true, force: true });
});

function cliPackage(dir: string) {
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"openclaw","version":"1.2.3"}');
  fs.writeFileSync(path.join(dir, "openclaw.mjs"), "");
  fs.writeFileSync(path.join(dir, "dist", "index.js"), "");
  return dir;
}

it("keeps the service's CLI when Doctor runs from npx and the durable copy is missing", async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "doctor-plan-")));
  const npx = cliPackage(path.join(root, ".npm", "_npx", "abc", "node_modules", "openclaw"));
  const service = cliPackage(path.join(root, "global", "node_modules", "openclaw"));
  process.argv = [process.execPath, path.join(npx, "openclaw.mjs"), "doctor"];
  const entrypoint = path.join(service, "dist", "index.js");

  const plan = await buildExpectedGatewayServicePlan({
    cfg: {},
    command: { programArguments: [process.execPath, entrypoint, "gateway", "--port", "18789"] },
    serviceInstallEnv: { OPENCLAW_STATE_DIR: path.join(root, "state") },
    port: 18789,
    runtime: "node",
    runtimePath: process.execPath,
  });

  expect(plan.programArguments).toContain(entrypoint);
  expect(plan.programArguments.join(" ")).not.toContain("_npx");
});
