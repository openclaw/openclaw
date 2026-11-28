import fs from "node:fs";
import path from "node:path";
import { writeManagedNpmPlugin } from "../plugins/test-helpers/managed-npm-plugin.js";

export function createInstalledReloadPackageWriter({
  stateDir,
  settings,
  usesMiddleware,
  cleanupFault,
}: {
  stateDir: string;
  settings: "empty" | "defaulted";
  usesMiddleware: boolean;
  cleanupFault?: { registrationEvent: string; resourcePath: string; stopFailurePath: string };
}) {
  return (
    id: string,
    packageDir = writeManagedNpmPlugin({
      stateDir,
      packageName: id,
      pluginId: id,
      version: "1.0.0",
    }),
  ) => {
    const middlewareOnly = usesMiddleware && id === "installed-probe";
    fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: id,
        version: "1.0.0",
        openclaw: { extensions: ["./index.ts"], runtimeExtensions: ["./dist/index.js"] },
      }),
    );
    fs.writeFileSync(path.join(packageDir, "index.ts"), "throw new Error('unselected source');");
    fs.writeFileSync(
      path.join(packageDir, "openclaw.plugin.json"),
      JSON.stringify({
        id,
        ...(middlewareOnly
          ? { contracts: { agentToolResultMiddleware: ["openclaw"] } }
          : { activation: { onStartup: true } }),
        configSchema:
          id === "sibling"
            ? {
                type: "object",
                additionalProperties: false,
                properties:
                  settings === "defaulted" ? { mode: { type: "string", default: "auto" } } : {},
              }
            : { type: "object" },
      }),
    );
    fs.writeFileSync(path.join(packageDir, "dist", "helper.cjs"), 'module.exports = "A";');
    fs.writeFileSync(
      path.join(packageDir, "dist", "index.js"),
      `const helper = require("./helper.cjs");
const instance = require("node:crypto").randomUUID();
let starts = 0, stops = 0;
module.exports = { id: ${JSON.stringify(id)}, register(api) {
  ${
    cleanupFault && id === "installed-probe"
      ? `const fs = require('node:fs');
  process.emit(${JSON.stringify(cleanupFault.registrationEvent)}, instance, __filename);
  const resource = fs.openSync(${JSON.stringify(cleanupFault.resourcePath)}, 'wx');
  api.lifecycle.onDispose(() => {
    fs.closeSync(resource);
    fs.unlinkSync(${JSON.stringify(cleanupFault.resourcePath)});
  });
  api.on('gateway_stop', () => {
    if (fs.existsSync(${JSON.stringify(cleanupFault.stopFailurePath)})) {
      throw new Error('previous stop hook refused cleanup');
    }
  });`
      : ""
  }
  ${
    middlewareOnly
      ? `api.registerAgentToolResultMiddleware((event) => ({
    result: { ...event.result, content: [{ type: "text", text: helper }] },
  }), { matcher: ["exec"] });`
      : ""
  }
  api.registerService({ id: ${JSON.stringify(id)}, start() {
    if (api.pluginConfig?.failStart) throw new Error("synthetic candidate start failed");
    starts++;
  }, stop() {
    stops++;
  } });
  api.registerGatewayMethod(${JSON.stringify(`${id}.probe`)}, ({ respond }) => {
    respond(true, { helper, instance, starts, stops, settings: api.pluginConfig });
  });
} };`,
    );
    return packageDir;
  };
}
