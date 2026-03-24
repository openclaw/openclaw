import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import {
  emitDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "./dist/infra/diagnostic-events.js";
// Run vitest programmatically or just mock what it does?
// Actually simpler:
import { loadOpenClawPlugins } from "./dist/plugins/loader.js";

const fixtureRoot = fs.mkdtempSync(path.join(process.cwd(), "openclaw-plugin-"));

const pluginDir = path.join(fixtureRoot, "legacy-root-diagnostic-listener");
fs.mkdirSync(pluginDir, { recursive: true });

const body = `module.exports = {
  id: "legacy-root-diagnostic-listener",
  configSchema: (require("openclaw/plugin-sdk").emptyPluginConfigSchema)(),
  register() {
    const { onDiagnosticEvent } = require("openclaw/plugin-sdk");
    if (typeof onDiagnosticEvent !== "function") {
      throw new Error("missing onDiagnosticEvent root export");
    }
    globalThis.__seen = [];
    onDiagnosticEvent((event) => {
      globalThis.__seen.push({
        type: event.type,
        sessionKey: event.sessionKey,
      });
    });
  },
};`;

const pluginFile = path.join(pluginDir, "legacy-root-diagnostic-listener.cjs");
fs.writeFileSync(pluginFile, body, "utf8");

fs.writeFileSync(
  path.join(pluginDir, "openclaw.plugin.json"),
  JSON.stringify({ id: "legacy-root-diagnostic-listener" }),
  "utf8",
);

console.log("START LOAD");
try {
  loadOpenClawPlugins({
    cache: false,
    workspaceDir: pluginDir,
    config: {
      plugins: {
        load: { paths: [pluginFile] },
        allow: ["legacy-root-diagnostic-listener"],
      },
    },
  });

  console.log("LOADED. EMITTING EVENT...");
  emitDiagnosticEvent({
    type: "model.usage",
    sessionKey: "agent:main:test:dm:peer",
    usage: { total: 1 },
  });

  console.log("SEEN ARRAY:", globalThis.__seen);
} catch (err) {
  console.error("ERROR", err);
}

fs.rmSync(fixtureRoot, { recursive: true, force: true });
console.log("DONE");
