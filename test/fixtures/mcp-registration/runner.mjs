import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const [repository, mode = "plain", fixtureRoot] = process.argv.slice(2);
assert.ok(repository, "Pass the new task worktree as the first argument");
assert.ok(["plain", "nested", "close-failure"].includes(mode));
const repo = fs.realpathSync(repository);
const require = createRequire(path.join(repo, "package.json"));
const { Client } = await import(
  pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js"))
);
const { StdioClientTransport } = await import(
  pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/stdio.js"))
);
assert.ok(fixtureRoot, "The process owner must supply the temporary directory");
const root = fs.realpathSync(fixtureRoot);
const pluginDir = path.join(root, "plugin");
const stateDir = path.join(root, "state");
const gateDir = path.join(root, "gates");
const workspaceDir = path.join(root, "workspace");
for (const dir of [pluginDir, stateDir, gateDir, workspaceDir, path.join(root, "home")]) {
  fs.mkdirSync(dir, { recursive: true });
}
const databasePath = path.join(root, "registration.sqlite");
const pluginFile = path.join(pluginDir, "index.cjs");
fs.copyFileSync(new URL("./plugin.cjs", import.meta.url), pluginFile);
const id = "mcp-registration-fixture";
const tool = "mcp_native_hold";
fs.writeFileSync(
  path.join(pluginDir, "package.json"),
  JSON.stringify({
    name: "mcp-registration-fixture",
    version: "0.0.0",
    main: "index.cjs",
    openclaw: { extensions: ["./index.cjs"] },
  }),
);
fs.writeFileSync(
  path.join(pluginDir, "openclaw.plugin.json"),
  JSON.stringify({
    id,
    name: "Native MCP registration fixture",
    providers: [id],
    contracts: { tools: [tool] },
    configSchema: {
      type: "object",
      additionalProperties: false,
      required: ["databasePath", "gateDir", "workspaceDir"],
      properties: {
        databasePath: { type: "string" },
        gateDir: { type: "string" },
        workspaceDir: { type: "string" },
        nestedStages: {
          type: "array",
          items: { enum: ["factory", "handler", "abort", "harness"] },
        },
      },
    },
  }),
);
const configFile = path.join(stateDir, "openclaw.json");
fs.writeFileSync(
  configFile,
  JSON.stringify({
    agents: { defaults: { workspace: workspaceDir } },
    plugins: {
      enabled: true,
      allow: [id],
      load: { paths: [pluginFile] },
      slots: { memory: "none" },
      entries: {
        [id]: {
          enabled: true,
          config: {
            databasePath,
            gateDir,
            workspaceDir,
            nestedStages: mode === "nested" ? ["factory", "handler", "abort", "harness"] : [],
          },
        },
      },
    },
    tools: { allow: [tool] },
  }),
);
fs.symlinkSync(path.join(repo, "node_modules"), path.join(root, "node_modules"), "dir");
const bootstrap = path.join(root, "serve.mjs");
const closeFault =
  mode === "close-failure"
    ? `
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
const close = StdioServerTransport.prototype.close;
StdioServerTransport.prototype.close = async function() {
  await close.call(this);
  throw new Error("synthetic transport close failure");
};
`
    : "";
fs.writeFileSync(
  bootstrap,
  `${closeFault}
import { servePluginToolsMcp } from ${JSON.stringify(pathToFileURL(path.join(repo, "src/mcp/plugin-tools-serve.ts")).href)};
try {
  await servePluginToolsMcp();
  process.stderr.write('MCP_OWNERSHIP_PROOF {"phase":"serve-returned"}\\n');
} catch (error) {
  process.stderr.write('MCP_OWNERSHIP_PROOF ' + JSON.stringify({phase: "serve-failed", error: String(error)}) + '\\n');
  process.exitCode = 1;
}
`,
);
const transport = new StdioClientTransport({
  command: process.execPath,
  cwd: repo,
  args: ["--import", path.join(repo, "scripts/tsx.mjs"), bootstrap],
  stderr: "pipe",
  env: {
    HOME: path.join(root, "home"),
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configFile,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  },
});
const client = new Client(
  { name: "native-registration-proof", version: "0.0.0" },
  { capabilities: {} },
);
const phases = [];
const listeners = new Map();
let closed = false;
let resolveClosed;
const closedPromise = new Promise((resolve) => {
  resolveClosed = resolve;
});
// oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Client exposes a callback property, not EventTarget.
client.onclose = () => {
  closed = true;
  resolveClosed();
  for (const [phase, listener] of listeners) {
    listener.reject(new Error(`Child closed before ${phase}`));
  }
  listeners.clear();
};
let stderr = "";
let buffered = "";
transport.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
  buffered += chunk.toString();
  for (;;) {
    const end = buffered.indexOf("\n");
    if (end < 0) {
      break;
    }
    const line = buffered.slice(0, end);
    buffered = buffered.slice(end + 1);
    if (!line.startsWith("MCP_OWNERSHIP_PROOF ")) {
      continue;
    }
    const event = JSON.parse(line.slice("MCP_OWNERSHIP_PROOF ".length));
    phases.push(event);
    listeners.get(event.phase)?.resolve(event);
    listeners.delete(event.phase);
  }
});
const waitFor = (phase) => {
  const seen = phases.find((event) => event.phase === phase);
  if (seen) {
    return Promise.resolve(seen);
  }
  if (closed) {
    return Promise.reject(new Error(`Child already closed before ${phase}`));
  }
  return new Promise((resolve, reject) => {
    listeners.set(phase, { resolve, reject });
  });
};
const release = (name) => fs.writeFileSync(path.join(gateDir, name), "release\n");
const rows = () => {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database
      .prepare("SELECT phase FROM events ORDER BY seq")
      .all()
      .map((row) => row.phase);
  } finally {
    database.close();
  }
};
let callResult;
let result;
try {
  await client.connect(transport);
  assert.deepEqual(
    (await client.listTools()).tools.map((entry) => entry.name),
    [tool],
  );
  callResult = client.callTool({ name: tool, arguments: {} }).then(
    (value) => ({ value }),
    (error) => ({ error: String(error) }),
  );
  await waitFor("tool-entered");
  assert.equal(
    rows().filter((phase) => phase === "registered").length,
    1,
    "SDK lookup must use the original tool registry",
  );
  const ownedPid = transport.pid;
  assert.ok(Number.isInteger(ownedPid), "SDK must expose the process it created");
  process.kill(ownedPid, "SIGTERM");
  assert.equal((await waitFor("request-aborted")).databaseOpen, true);
  assert.ok(!rows().includes("dispose-entered"));
  release("tool.release");
  await waitFor("tool-written");
  assert.equal((await waitFor("dispose-entered")).databaseOpen, true);
  assert.ok(!phases.some((event) => event.phase === "serve-returned"));
  release("dispose.release");
  assert.equal((await waitFor("disposed")).databaseOpen, false);
  if (mode === "close-failure") {
    assert.match((await waitFor("serve-failed")).error, /synthetic transport close failure/);
    assert.ok(!phases.some((event) => event.phase === "serve-returned"));
  } else {
    await waitFor("serve-returned");
  }
  await closedPromise;
  await callResult;
  const events = rows();
  assert.equal(events.filter((phase) => phase === "registered").length, 1);
  assert.ok(events.indexOf("tool-written") < events.indexOf("dispose-entered"));
  assert.equal(events.at(-1), "dispose-completed");
  assert.ok(!events.includes("semantic-cleanup"));
  if (mode === "nested") {
    for (const stage of ["factory", "handler", "abort", "harness"]) {
      assert.ok(events.includes(`sdk:${stage}`));
    }
    assert.ok(events.indexOf("tool-written") < events.indexOf("harness-disposed"));
    assert.ok(events.indexOf("harness-disposed") < events.indexOf("dispose-entered"));
  }
  result = { ok: true, mode, events, phases, root };
} catch (error) {
  result = { ok: false, mode, error: String(error), phases, root };
  process.exitCode = 1;
} finally {
  release("tool.release");
  release("dispose.release");
  await client.close();
  await callResult;
  fs.writeFileSync(path.join(root, "stderr.log"), stderr);
  fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(result, null, 2));
}
console.log(JSON.stringify(result, null, 2));
