import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { formatPluginLine } from "../cli/plugins-list-format.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { VERSION } from "../version.js";
import { createPluginRecord, recordPluginError } from "./loader-records.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

const tempDirs = createTempDirTracker();
afterEach(() => tempDirs.cleanup());
// Native Node avoids the host test process's SDK aliases.
const importProbe =
  'try { await import(process.argv[1]); console.log("null"); } catch (error) { console.log(JSON.stringify({name:error.name,message:error.message,code:error.code})); }';

function write(target: string, content: string | object) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof content === "string" ? content : JSON.stringify(content));
}

it.each([
  ["missing export", false, false, undefined, undefined],
  ["wrapped missing export", false, true, undefined, undefined],
  ["nested SDK", true, false, undefined, undefined],
  ["wrapped nested SDK", true, true, undefined, undefined],
  ["channel setup classification", true, false, "channel-setup-failure", undefined],
  ["plugin id requiring quoting", false, false, undefined, "custom plugin"],
] as const)("diagnoses %s", (_name, nestedSdk, wrapped, diagnosticCode, pluginId) => {
  const project = tempDirs.make("openclaw-sdk-skew-");
  const id = pluginId ?? (nestedSdk ? "third-party-fixture" : "whatsapp");
  const packageName = nestedSdk ? "@fixture/third-party" : "@openclaw/whatsapp";
  const rootDir = path.join(project, "node_modules", packageName);
  const sdkRoot = path.join(nestedSdk ? rootDir : project, "node_modules", "openclaw");
  const seam = `openclaw/plugin-sdk/${nestedSdk ? "channel-runtime" : "agent-harness-runtime"}`;
  write(path.join(sdkRoot, "package.json"), {
    exports: nestedSdk ? {} : { "./plugin-sdk/agent-harness-runtime": "./runtime.mjs" },
  });
  write(path.join(sdkRoot, "runtime.mjs"), "export const available = true;");
  const source = path.join(rootDir, "index.mjs");
  write(
    source,
    nestedSdk
      ? `import ${JSON.stringify(seam)};`
      : `import { MISSING_FIXTURE_EXPORT } from ${JSON.stringify(seam)}; export default MISSING_FIXTURE_EXPORT;`,
  );
  const args = ["--input-type=module", "-e", importProbe, pathToFileURL(source).href];
  const result = JSON.parse(execFileSync(resolveTestNodeExecPath(), args, { encoding: "utf8" }));
  expect(result).toMatchObject(
    nestedSdk ? { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" } : { name: "SyntaxError" },
  );
  const nativeError = Object.assign(new Error(result.message), result);
  const record = createPluginRecord({
    id,
    source,
    rootDir,
    builtWithOpenClawVersion: "2026.7.1",
    origin: "global",
    enabled: true,
    configSchema: false,
  });
  const registry = createEmptyPluginRegistry();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  recordPluginError({
    logger,
    registry,
    record,
    seenIds: new Map(),
    phase: "load",
    diagnosticCode,
    error: wrapped ? new Error("native import failed", { cause: nativeError }) : nativeError,
  });
  expect(logger.error).toHaveBeenCalledTimes(1);
  expect(registry.diagnostics).toHaveLength(1);
  expect(registry.diagnostics[0]).toMatchObject({
    pluginId: id,
    code: diagnosticCode ?? "sdk-incompatible",
    sdkCompatibility: {
      seam,
      coreVersion: VERSION,
      builtWithOpenClawVersion: "2026.7.1",
      nestedSdk,
    },
  });
  const action = nestedSdk
    ? "this plugin bundles an incompatible OpenClaw SDK; update it or contact its author"
    : pluginId
      ? "update this plugin or contact its author"
      : "run `openclaw plugins update whatsapp`";
  for (const text of [
    record.error,
    formatPluginLine(record),
    registry.diagnostics[0]?.message,
    logger.error.mock.calls[0]?.[0],
  ]) {
    for (const part of [id, seam, VERSION, action]) {
      expect(text).toContain(part);
    }
  }
});
