import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

const [role, version, shutdown, root] = isMainThread ? process.argv.slice(2) : workerData;
const fixture = fileURLToPath(import.meta.url);
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";

if (role === "server") {
  const { createToolsMcpServer, connectToolsMcpServerToStdio } =
    await import("./tools-stdio-server.ts");
  const report = (phase) => process.stderr.write(`MCP_LIFECYCLE ${JSON.stringify({ phase })}\n`);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => report(signal));
  }
  const server = createToolsMcpServer({
    name: "stdio-lifecycle",
    tools: [
      {
        name: "hold",
        label: "Hold",
        description: "Hold real work across transport shutdown",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: async (_id, _args, signal) => {
          assert.ok(signal);
          const released = new Promise((resolve) => {
            process.once("message", (message) => {
              assert.equal(message, "release");
              resolve();
            });
          });
          const aborted = new Promise((resolve) => {
            signal.addEventListener("abort", resolve, { once: true });
          });
          report("entered");
          await aborted;
          report("aborted");
          await released;
          await writeFile(path.join(root, "drained"), "drained");
          report("drained");
          return { content: [{ type: "text", text: "done" }], details: {} };
        },
      },
    ],
  });
  await connectToolsMcpServerToStdio(server);
  report("returned");
  process.disconnect();
} else if (role === "worker") {
  const worker = new Worker(new URL(import.meta.url), {
    workerData: ["client", version, shutdown, root],
  });
  const completed = new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
  const exited = new Promise((resolve) => {
    worker.once("exit", resolve);
  });
  const result = await completed;
  assert.equal(await exited, 0);
  console.log(JSON.stringify(result));
} else {
  const { Client } =
    version === "v1"
      ? await import("@modelcontextprotocol/sdk/client/index.js")
      : await import("@modelcontextprotocol/client");
  // Framing stays SDK-owned; this transport gives the proof direct EOF control,
  // without StdioClientTransport.close() escalating to signals after two seconds.
  const { ReadBuffer, serializeMessage } =
    await import("@modelcontextprotocol/sdk/shared/stdio.js");
  const child = spawn(
    process.execPath,
    [
      ...(process.versions.bun
        ? ["--no-install"]
        : ["--import", new URL("../../scripts/tsx.mjs", import.meta.url).href]),
      fixture,
      "server",
      version,
      shutdown,
      root,
    ],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: {
        PATH: process.env.PATH,
        HOME: root,
        USERPROFILE: root,
        OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
        OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      serialization: "json",
      windowsHide: true,
    },
  );
  const spawned = new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const buffer = new ReadBuffer();
  const exited = new Promise((resolve) => {
    child.once("close", (code, signal) => {
      transport.onclose?.();
      resolve({ code, signal });
    });
  });
  const transport = {
    start: () => spawned,
    send: (message) =>
      new Promise((resolve, reject) => {
        child.stdin.write(serializeMessage(message), (error) =>
          error ? reject(error) : resolve(),
        );
      }),
    close: async () => {
      child.stdin.end();
      await exited;
    },
  };
  child.stdout.on("data", (chunk) => {
    try {
      buffer.append(chunk);
      for (let message; (message = buffer.readMessage()) !== null;) {
        transport.onmessage?.(message);
      }
    } catch (error) {
      transport.onerror?.(error);
    }
  });
  child.stdout.on("error", (error) => transport.onerror?.(error));
  child.stdin.on("error", (error) => transport.onerror?.(error));
  const client = new Client({ name: "stdio-peer", version: "0.0.0" }, { capabilities: {} });
  const phases = [];
  const pending = new Map();
  let diagnostics = "";
  let closeResolve;
  const closed = new Promise((resolve) => {
    closeResolve = resolve;
  });
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP exposes an onclose callback rather than an EventTarget.
  client.onclose = () => {
    closeResolve();
    for (const [phase, waiter] of pending) {
      waiter.reject(new Error(`Closed before ${phase}: ${diagnostics}`));
    }
    pending.clear();
  };
  const lines = createInterface({ input: child.stderr });
  lines.on("line", (line) => {
    diagnostics += `${line}\n`;
    if (!line.startsWith("MCP_LIFECYCLE ")) {
      return;
    }
    const { phase } = JSON.parse(line.slice("MCP_LIFECYCLE ".length));
    phases.push(phase);
    pending.get(phase)?.resolve();
    pending.delete(phase);
  });
  const waitFor = (phase) =>
    phases.includes(phase)
      ? Promise.resolve()
      : new Promise((resolve, reject) => {
          pending.set(phase, { resolve, reject });
        });
  let call;
  let released = false;
  const releaseWork = async () => {
    if (released || !child.connected) {
      return;
    }
    released = true;
    await new Promise((resolve, reject) => {
      child.send("release", (error) => (error ? reject(error) : resolve()));
    });
  };
  try {
    await client.connect(transport);
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name),
      ["hold"],
    );
    call = client.callTool({ name: "hold", arguments: {} }).then(
      () => "result",
      () => "closed",
    );
    await waitFor("entered");
    const pid = child.pid;
    if (shutdown === "EOF") {
      child.stdin.end();
    } else {
      process.kill(pid, shutdown);
    }
    // Windows process.kill terminates unconditionally; EOF still proves graceful drain.
    const abrupt = process.platform === "win32" && shutdown !== "EOF";
    if (!abrupt) {
      await waitFor("aborted");
      assert.ok(
        !phases.includes("returned"),
        "Serving must join accepted work after transport cancellation",
      );
      await releaseWork();
      await waitFor("returned");
    }
    await closed;
    const exit = await exited;
    assert.equal(await call, "closed");
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    if (abrupt) {
      assert.deepEqual(phases, ["entered"]);
    } else {
      assert.deepEqual(exit, { code: 0, signal: null });
      assert.deepEqual(
        phases.filter((phase) => phase.startsWith("SIG")),
        shutdown === "EOF" ? [] : [shutdown],
      );
      assert.ok(phases.indexOf("aborted") < phases.indexOf("drained"));
      assert.ok(phases.indexOf("drained") < phases.indexOf("returned"));
      assert.equal(await readFile(path.join(root, "drained"), "utf8"), "drained");
    }
    const result = { version, shutdown, worker: !isMainThread, abrupt, phases };
    if (parentPort) {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- A Worker MessagePort has no Window target origin.
      parentPort.postMessage(result);
    } else {
      console.log(JSON.stringify(result));
    }
  } catch (error) {
    process.stderr.write(diagnostics);
    throw error;
  } finally {
    await releaseWork();
    await client.close();
    await exited;
    await call;
    lines.close();
  }
}
