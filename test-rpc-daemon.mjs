import { spawn } from "child_process";
import http from "node:http";
import path from "path";

const PORT = 34567;
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/rpc/openclaw-tool") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const payload = JSON.parse(body);
      const session = req.headers["x-openclaw-session"];

      console.log("[DAEMON] Received request:");
      console.log("  Session:", session);
      console.log("  Args:", payload.args);
      console.log("  Stdin:", payload.stdin);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          stdout: "MOCK: successfully listed agents!\n",
          exitCode: 0,
        }),
      );
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[TEST] Test Daemon started on port ${PORT}`);

  const clientPath = path.resolve("./src/agents/cli-runner/thin-client.mjs");
  console.log(`[TEST] Running thin client at ${clientPath}...`);

  const child = spawn("node", [clientPath, "agents", "list", "--limit", "5"], {
    env: {
      ...process.env,
      OPENCLAW_RPC_PORT: String(PORT),
      OPENCLAW_INTERNAL_SESSION: "mock-session-key-42",
    },
  });

  child.stdin.write("some piped data from cat");
  child.stdin.end();

  child.stdout.on("data", (data) => console.log("[TEST] Client Stdout: " + data.toString().trim()));
  child.stderr.on("data", (data) => console.log("[TEST] Client Stderr: " + data.toString().trim()));

  child.on("close", (code) => {
    console.log("[TEST] Client Exit Code:", code);
    server.close();
  });
});
