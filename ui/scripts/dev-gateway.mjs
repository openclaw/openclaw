import { spawn } from "node:child_process";

const DEFAULT_HTTP = "http://127.0.0.1:18789";
const DEFAULT_WS = "ws://127.0.0.1:18789";

const env = { ...process.env };
env.CLAWDBOT_CONTROL_UI_PROXY_TARGET ||= DEFAULT_HTTP;
env.VITE_CLAWDBOT_CONTROL_UI_DEFAULT_GATEWAY_URL ||= DEFAULT_WS;
env.VITE_CLAWDBOT_CONTROL_UI_DEFAULT_GATEWAY_PASSWORD ||=
  env.CLAWDBOT_CONTROL_UI_DEFAULT_GATEWAY_PASSWORD || env.PASSWORD;

const child = spawn("pnpm", ["dev"], { stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 1));
