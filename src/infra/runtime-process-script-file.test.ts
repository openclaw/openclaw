import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { createRuntimeProcessScriptFile } from "../../runtime-process-scripts.generated.mjs";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { prepareRuntimeProcessScriptInvocation } from "./runtime-process-url.js";

const directories = useAutoCleanupTempDirTracker((cleanup) => afterEach(cleanup));
const node = resolveTestNodeExecPath();

it("runs and removes retained programs without source neighbors", () => {
  const root = directories.make("runtime-script-bootstrap-");
  const scriptParent = path.join(root, "scratch");
  fs.mkdirSync(scriptParent, { mode: 0o700 });
  const copiedBootstrap = path.join(root, "runtime-process-scripts.generated.mjs");
  fs.copyFileSync(
    new URL("../../runtime-process-scripts.generated.mjs", import.meta.url),
    copiedBootstrap,
  );
  const database = path.join(root, "database.sqlite");
  fs.writeFileSync(database, "database");
  fs.writeFileSync(database + "-wal", "wal");
  const driver = path.join(root, "driver.mjs");
  fs.writeFileSync(
    driver,
    `
    import { createRuntimeProcessScriptFile } from "./runtime-process-scripts.generated.mjs";
    import { execFileSync } from "node:child_process";
    import fs from "node:fs";
    import { fileURLToPath } from "node:url";
    const result = {};
    for (const name of ["nodeRuntimeProbe", "daemonRuntimeProbe", "updateStateSizes"]) {
      const script = createRuntimeProcessScriptFile(name);
      if (process.platform !== "win32" && (fs.statSync(new URL(".", script.url)).mode & 0o777) !== 0o700) throw new Error("Script directory is not private");
      try {
        result[name] = execFileSync(process.execPath, [fileURLToPath(script.url), name === "daemonRuntimeProbe" ? "node" : ""], {
          encoding: "utf8", timeout: 5000, env: {},
          input: JSON.stringify({files: [${JSON.stringify(database)}]}),
          stdio: ["pipe", "pipe", "ignore"],
        });
      } finally {
        script.dispose();
      }
      if (fs.existsSync(fileURLToPath(new URL(".", script.url)))) throw new Error("Script survived disposal");
    }
    process.stdout.write(JSON.stringify(result));
  `,
  );
  const result = spawnSync(node, [driver], {
    encoding: "utf8",
    timeout: 15_000,
    env: { TMPDIR: scriptParent, TMP: scriptParent, TEMP: scriptParent },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(fs.readdirSync(scriptParent)).toEqual([]);
  const output = JSON.parse(result.stdout);
  expect(output.nodeRuntimeProbe).toBe(node);
  expect(JSON.parse(output.daemonRuntimeProbe)).toMatchObject({
    bunVersion: null,
    sqliteProbe: { available: true, text: true, blob: true, json: true },
  });
  expect(JSON.parse(output.updateStateSizes)).toEqual([{ path: database, sizeBytes: "11" }]);
});

it("passes required flags as data to the tested runtime", () => {
  const root = directories.make("runtime-script-required-flag-");
  const script = createRuntimeProcessScriptFile("nodeRuntimeProbe", { parentDirectory: root });
  try {
    const probe = (flag: string) =>
      spawnSync(node, [fileURLToPath(script.url), flag], {
        encoding: "utf8",
        timeout: 5000,
        env: {},
      });
    const supported = probe("--max-old-space-size");
    expect(supported.status, supported.stderr).toBe(0);
    expect(supported.stdout).toBe(node);
    const unsupported = probe("--openclaw-unsupported-'\";process.exit(42)");
    expect(unsupported.status, unsupported.stderr).toBe(0);
    expect(unsupported.stdout).toBe("");
  } finally {
    script.dispose();
  }
});

it("uses embedded self dispatch while keeping external runtime scripts physical", () => {
  const root = directories.make("runtime-script-dispatch-");
  vi.stubGlobal("__openclawStandaloneIsEmbeddedModule", () => true);
  vi.spyOn(process, "versions", "get").mockReturnValue({ ...process.versions, bun: "fixture" });
  try {
    const embedded = prepareRuntimeProcessScriptInvocation("updateStateSizes", process.execPath, {
      parentDirectory: root,
    });
    expect(embedded.argv).toEqual([
      process.execPath,
      "--no-install",
      expect.stringMatching(/update-state-sizes\.entry\.[cm]?[jt]s$/),
    ]);
    expect(fs.readdirSync(root)).toEqual([]);
    embedded.dispose();
    const external = prepareRuntimeProcessScriptInvocation("updateStateSizes", "/external/node", {
      parentDirectory: root,
    });
    try {
      expect(external.argv[0]).toBe("/external/node");
      expect(fs.existsSync(expectDefined(external.argv[1], "physical script entry"))).toBe(true);
    } finally {
      external.dispose();
    }
    expect(fs.readdirSync(root)).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
