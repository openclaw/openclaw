import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

if (process.env.FIXTURE_INVOCATIONS) {
  appendFileSync(process.env.FIXTURE_INVOCATIONS, JSON.stringify(process.argv) + "\n");
}
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const server = createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(request.url === "/readyz" ? { ready: true } : { completed: true }));
});
server.listen(port, "127.0.0.1");
process.once("SIGTERM", () => {
  if (process.env.FIXTURE_STOP_ERROR === "1") {
    console.error("[error] fixture service stop failed");
  }
  server.close(() => {
    process.disconnect();
    process.exit(Number(process.env.FIXTURE_EXIT_CODE ?? 0));
  });
});
