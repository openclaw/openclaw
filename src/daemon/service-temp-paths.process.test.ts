import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs = new Set<string>();
const serviceModuleUrl = new URL("./service.ts", import.meta.url).href;

afterEach(() => {
  for (const tempDir of tempDirs) {
    tempDirs.delete(tempDir);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function createTempDir() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-daemon-temp-")));
  tempDirs.add(root);
  return root;
}

function runServiceStartChild(tempRoot: string, programArguments: string[]): unknown {
  const script = `
    const { startGatewayService } = await import(${JSON.stringify(serviceModuleUrl)});
    let startCalls = 0;
    const service = {
      label: "test service",
      loadedText: "loaded",
      notLoadedText: "not loaded",
      isLoaded: async () => true,
      readCommand: async () => ({ programArguments: ${JSON.stringify(programArguments)} }),
      readRuntime: async () => ({ status: startCalls ? "running" : "stopped" }),
      start: async () => { startCalls += 1; },
    };
    const result = await startGatewayService(service, { env: {}, stdout: process.stdout });
    process.stdout.write(JSON.stringify({
      outcome: result.outcome,
      issueCodes: "issues" in result ? result.issues.map((issue) => issue.code) : [],
      startCalls,
    }));
  `;
  const result = spawnSync(
    process.execPath,
    ["--import", "./scripts/tsx.mjs", "--input-type=module", "--eval", script],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: undefined,
        NODE_OPTIONS: undefined,
        TEMP: tempRoot,
        TMP: tempRoot,
        TMPDIR: tempRoot,
        VITEST: undefined,
      },
      timeout: 30_000,
    },
  );
  const diagnostics = `${result.stderr}\n${result.stdout}`;
  expect(result.error, diagnostics).toBeUndefined();
  expect(result.status, diagnostics).toBe(0);
  return JSON.parse(result.stdout);
}

describe("service temporary program paths", () => {
  it("does not treat the filesystem root as a temporary program directory", () => {
    expect(
      runServiceStartChild(path.parse(process.execPath).root, [process.execPath, "gateway", "run"]),
    ).toEqual({ outcome: "started", issueCodes: [], startCalls: 1 });
  });

  it.runIf(process.platform === "win32").each(["executable", "entrypoint"])(
    "requests repair before starting a case-varied Windows temporary %s",
    (position) => {
      const tempRoot = createTempDir();
      const programPath = path.join(tempRoot, "Gateway", "entry.js");
      fs.mkdirSync(path.dirname(programPath), { recursive: true });
      fs.writeFileSync(programPath, "");
      const caseVariant = tempRoot.replace(/[A-Za-z]/g, (char) =>
        char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase(),
      );
      const args = position === "executable" ? [programPath] : [process.execPath, programPath];

      expect(runServiceStartChild(caseVariant, [...args, "gateway", "run"])).toEqual({
        outcome: "repair-required",
        issueCodes: ["temporary-program"],
        startCalls: 0,
      });
    },
  );

  it.runIf(process.platform === "win32")(
    "starts an existing entrypoint beside a similarly named temporary directory",
    () => {
      const root = createTempDir();
      const tempRoot = path.join(root, "temp");
      const entrypoint = path.join(root, "temp-sibling", "entry.js");
      fs.mkdirSync(tempRoot);
      fs.mkdirSync(path.dirname(entrypoint));
      fs.writeFileSync(entrypoint, "");

      expect(
        runServiceStartChild(tempRoot, [process.execPath, entrypoint, "gateway", "run"]),
      ).toEqual({ outcome: "started", issueCodes: [], startCalls: 1 });
    },
  );
});
