import { realpath } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createOpenClawTestInstance, type OpenClawTestInstance } from "./openclaw-test-instance.js";

const instances = new Set<OpenClawTestInstance>();

afterEach(async () => {
  for (const instance of instances) {
    await instance.cleanup();
    instances.delete(instance);
  }
});

const entrypoint = [
  "--input-type=module",
  "--eval",
  `
import { realpathSync } from "node:fs";
import { createServer } from "node:http";
const identity = {
  executable: realpathSync(process.execPath),
  runtime: process.versions.bun ? "bun" : "node",
};
if (process.argv.includes("runtime-identity")) {
  console.log(JSON.stringify(identity));
} else {
  const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
  createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ready: true, ...identity }));
  }).listen(port, "127.0.0.1");
}
`,
  "--",
];

it.each([
  { flow: "Gateway", mode: "selected runtime", explicitNode: false },
  { flow: "CLI", mode: "selected runtime", explicitNode: false },
  { flow: "Gateway", mode: "explicit Node override", explicitNode: true },
  { flow: "CLI", mode: "explicit Node override", explicitNode: true },
])("executes $flow with the $mode", async ({ flow, explicitNode }) => {
  const node = resolveTestNodeExecPath();
  const selected = explicitNode ? node : process.execPath;
  const expected = {
    executable: await realpath(selected),
    runtime: !explicitNode && process.versions.bun ? "bun" : "node",
  };
  const instance = await createOpenClawTestInstance({
    name: "runtime-inheritance",
    entrypoint,
    // A Bun-backed node shim must not make the old PATH lookup look correct.
    env: { PATH: [path.dirname(node), process.env.PATH ?? ""].join(path.delimiter) },
    ...(explicitNode ? { gatewayCommandPrefix: [node] } : {}),
  });
  instances.add(instance);

  if (flow === "Gateway") {
    await instance.startGateway();
    const response = await fetch(`http://127.0.0.1:${instance.port}/readyz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ready: true, ...expected });
  } else {
    const result = await instance.cli(
      ["runtime-identity"],
      explicitNode ? { execPath: node } : undefined,
    );
    expect({ code: result.code, signal: result.signal }).toEqual({ code: 0, signal: null });
    expect(JSON.parse(result.stdout)).toEqual(expected);
  }
});
