import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { createRuntimeProcessScriptFile } from "../../runtime-process-scripts.generated.mjs";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { prepareRuntimeProcessScriptInvocation } from "./runtime-process-url.js";

const directories = useAutoCleanupTempDirTracker((cleanup) => afterEach(cleanup));
const node = resolveTestNodeExecPath();
const runScript = (url: URL, flag = "", input?: string) =>
  execFileSync(node, [fileURLToPath(url), flag], {
    encoding: "utf8",
    timeout: 5000,
    env: {},
    input,
  });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("runs and removes retained programs without source neighbors", async () => {
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
  const bootstrap: typeof import("../../runtime-process-scripts.generated.mjs") = await import(
    pathToFileURL(copiedBootstrap).href
  );
  const output = { nodeRuntimeProbe: "", daemonRuntimeProbe: "", updateStateSizes: "" };
  for (const name of ["nodeRuntimeProbe", "daemonRuntimeProbe", "updateStateSizes"] as const) {
    const script = bootstrap.createRuntimeProcessScriptFile(name, {
      parentDirectory: scriptParent,
    });
    const directory = fileURLToPath(new URL(".", script.url));
    if (process.platform !== "win32") {
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    }
    {
      using _ = { [Symbol.dispose]: () => script.dispose() };
      output[name] = runScript(
        script.url,
        name === "daemonRuntimeProbe" ? "node" : "",
        JSON.stringify({ files: [database] }),
      );
    }
    expect(fs.readdirSync(scriptParent)).toEqual([]);
  }
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
  using _ = { [Symbol.dispose]: () => script.dispose() };
  expect(runScript(script.url, "--max-old-space-size")).toBe(node);
  expect(runScript(script.url, "--openclaw-unsupported-'\";process.exit(42)")).toBe("");
});

it("uses embedded self dispatch while keeping external runtime scripts physical", () => {
  const root = directories.make("runtime-script-dispatch-");
  vi.stubGlobal("__openclawStandaloneIsEmbeddedModule", () => true);
  vi.spyOn(process, "versions", "get").mockReturnValue({ ...process.versions, bun: "fixture" });
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
  {
    using _ = { [Symbol.dispose]: () => external.dispose() };
    expect(external.argv[0]).toBe("/external/node");
    expect(fs.existsSync(expectDefined(external.argv[1], "physical script entry"))).toBe(true);
  }
  expect(fs.readdirSync(root)).toEqual([]);
});
