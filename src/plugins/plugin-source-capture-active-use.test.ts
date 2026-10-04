import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as container from "../infra/container-environment.js";
import * as census from "../infra/openclaw-process-census.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { sweepPluginSourceCapturesForTest } from "./plugin-source-capture-directory.test-support.js";

const { procRead } = vi.hoisted(() => ({ procRead: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  procRead.mockImplementation(actual.readdirSync);
  return {
    ...actual,
    readdirSync: procRead,
    default: { ...actual, readdirSync: procRead },
  };
});

const temp = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it("preserves live open files and warns once when the process census is unreadable", async () => {
  const nativeLinux = process.platform === "linux";
  const stateDir = temp.make("capture-active-use-");
  const temporary = path.join(stateDir, "tmp");
  fs.mkdirSync(temporary);
  for (const key of ["TMPDIR", "TMP", "TEMP"]) {
    vi.stubEnv(key, temporary);
  }
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const roots = [
    path.join(temporary, "openclaw-plugin-build-held"),
    path.join(temporary, "openclaw-model-catalog-held"),
    path.join(temporary, "plugin-captures", "tokenless-held"),
  ];
  const files = roots.map((root) => {
    fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, "payload");
    fs.writeFileSync(file, "live payload");
    return file;
  });
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    const fs = require("node:fs");
    let handles = process.argv.slice(1).map(file => fs.openSync(file, "r"));
    const report = () => console.log(JSON.stringify(handles.map(fd => fs.fstatSync(fd).nlink)));
    process.stdin.on("data", command => {
      if (command.toString().trim() === "close") {
        handles.forEach(fd => fs.closeSync(fd));
        handles = [];
      }
      report();
    });
    process.stdin.on("end", () => { handles.forEach(fd => fs.closeSync(fd)); });
    report();
  `,
      ...files,
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });
  const reader = createInterface({ input: child.stdout });
  const lines = reader[Symbol.asyncIterator]();
  try {
    expect((await lines.next()).value).toBe("[1,1,1]");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1_000);
    mockProcessPlatform("linux");
    vi.spyOn(container, "isContainerEnvironment").mockReturnValue(false);
    const { readdirSync: readdir } = await vi.importActual<typeof import("node:fs")>("node:fs");
    let injectedEacces = 0;
    procRead.mockImplementation((target, options) => {
      if (target === "/proc") {
        injectedEacces++;
        throw Object.assign(new Error("EACCES: cannot read /proc"), { code: "EACCES" });
      }
      return readdir(target, options);
    });
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    await sweepPluginSourceCapturesForTest(stateDir);
    child.stdin.write("report\n");
    const links = (await lines.next()).value;
    console.log(
      `Live holder proof: injectedEacces=${injectedEacces}; exists=${roots.map((root) => fs.existsSync(root)).join(",")}; nlink=${links}`,
    );
    expect(injectedEacces).toBeGreaterThan(0);
    expect(links).toBe("[1,1,1]");
    expect(roots.every((root) => fs.existsSync(root))).toBe(true);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(String(warning.mock.calls[0]?.[0])).toContain("EACCES");
    await sweepPluginSourceCapturesForTest(stateDir);
    expect(warning).toHaveBeenCalledTimes(2);
    if (nativeLinux) {
      // Scope enumeration to this isolated fixture; descriptor/maps reads still use real procfs.
      const inventory = path.join(stateDir, "process-inventory");
      fs.mkdirSync(inventory);
      fs.mkdirSync(path.join(inventory, String(process.pid)));
      fs.mkdirSync(path.join(inventory, String(child.pid)));
      procRead.mockImplementation((target, options) =>
        readdir(target === "/proc" ? inventory : target, options),
      );
      vi.spyOn(census, "inspectOtherOpenClawProcesses").mockReturnValue({ pids: [] });
      warning.mockClear();
      await sweepPluginSourceCapturesForTest(stateDir);
      child.stdin.write("report\n");
      expect((await lines.next()).value).toBe("[1,1,1]");
      expect(roots.every((root) => fs.existsSync(root))).toBe(true);
      expect(warning).not.toHaveBeenCalled();
      child.stdin.write("close\n");
      expect((await lines.next()).value).toBe("[]");
      await sweepPluginSourceCapturesForTest(stateDir);
      expect(roots.some((root) => fs.existsSync(root))).toBe(false);
      expect(warning).not.toHaveBeenCalled();
      console.log(
        "Linux procfs proof: live holder preserved; closed holder reclaimed (all three roots)",
      );
    }
  } finally {
    child.stdin.end();
    await exited;
    reader.close();
  }
});
