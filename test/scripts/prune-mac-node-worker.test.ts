import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planMacNodeWorkerClosure } from "../../scripts/prune-mac-node-worker.js";
import { runtimeProcessEntrypoints } from "../../src/infra/runtime-process-entrypoints.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const tempDirs: string[] = [];
afterEach(() => cleanupTempDirs(tempDirs));

describe("Mac node worker package closure", () => {
  it.each([
    'resolveRuntimeProcessEntrypointUrl("serviceChildRelay")',
    "resolveRuntimeProcessEntrypointUrl('serviceChildRelay')",
    'resolve(process.platform === "win32" ? "serviceChildWindowsJobAnchor" : "serviceChildRelay")',
    "resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.serviceChildRelay)",
    'resolveRuntimeWorkerUrl(runtimeProcessEntrypoints["serviceChildRelay"])',
  ])("retains transitive worker dependencies for %s", (launch) => {
    const root = makeTempDir(tempDirs, "openclaw-mac-worker-closure-");
    const write = (relative: string, source: string) => {
      mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      writeFileSync(path.join(root, relative), source);
    };
    write("package.json", JSON.stringify({ name: "openclaw", version: "1.0.0" }));
    mkdirSync(path.join(root, "dist/extensions"), { recursive: true });
    write("dist/build-info.json", "{}");
    for (const entrypoint of Object.values(runtimeProcessEntrypoints)) {
      write(`dist/${entrypoint.distWorkerPath}`, "export {};\n");
    }
    write("dist/mac-node-worker.js", `${launch};\n`);
    write(
      "dist/process/supervisor/service-child-relay.js",
      'resolveRuntimeProcessEntrypointUrl("serviceChildGroupAnchor");\n',
    );
    write(
      "dist/process/supervisor/service-child-group-anchor.js",
      'import "./anchor-helper.js";\n',
    );
    write("dist/process/supervisor/anchor-helper.js", 'import "worker-runtime-dependency";\n');

    const closure = planMacNodeWorkerClosure(root, resolveTestNodeExecPath());

    expect(closure.files).toEqual(
      expect.arrayContaining([
        "dist/process/supervisor/service-child-relay.js",
        "dist/process/supervisor/service-child-group-anchor.js",
        "dist/process/supervisor/anchor-helper.js",
      ]),
    );
    expect(closure.dependencies).toContain("worker-runtime-dependency");
    expect(closure.files).not.toContain("dist/commands/doctor-lint.worker.js");
    if (launch.includes("win32")) {
      expect(closure.files).toContain(
        "dist/process/supervisor/service-child-windows-job-anchor.js",
      );
    }
  });
});
