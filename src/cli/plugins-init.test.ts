import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

vi.mock("../runtime.js", () => ({
  defaultRuntime: runtime,
}));

vi.mock("../terminal/theme.js", () => ({
  theme: {
    command: (v: string) => v,
    muted: (v: string) => v,
  },
}));

vi.mock("../utils.js", () => ({
  resolveUserPath: (p: string) => path.resolve(p),
}));

vi.mock("../plugins/manifest.js", () => ({
  PLUGIN_MANIFEST_FILENAME: "openclaw.plugin.json",
}));

let runPluginInit: typeof import("./plugins-init.js").runPluginInit;

beforeAll(async () => {
  ({ runPluginInit } = await import("./plugins-init.js"));
});

describe("plugins init", () => {
  let tmpDir: string;

  async function runCli(args: string[]) {
    const program = new Command();
    program
      .command("plugins")
      .command("init")
      .argument("[directory]")
      .option("--id <id>")
      .option("--name <name>")
      .option("--description <desc>")
      .option("--kind <kind>")
      .option("--force")
      .action((directory: string | undefined, opts: Record<string, unknown>) => {
        runPluginInit(directory, opts);
      });
    await program.parseAsync(["plugins", "init", ...args], { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-init-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("scaffolds plugin in target directory", async () => {
    const dir = path.join(tmpDir, "my-plugin");
    await runCli([dir, "--id", "my-plugin"]);

    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "openclaw.plugin.json"), "utf-8"));
    expect(manifest.id).toBe("my-plugin");
    expect(manifest.configSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {},
    });

    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
    expect(pkg.name).toBe("my-plugin");
    expect(pkg.type).toBe("module");
    expect(pkg.openclaw.extensions).toEqual(["./index.ts"]);

    const index = fs.readFileSync(path.join(dir, "index.ts"), "utf-8");
    expect(index).toContain("OpenClawPluginApi");
    expect(index).toContain("export default function register");
  });

  it("derives id from directory name", async () => {
    const dir = path.join(tmpDir, "cool-plugin");
    await runCli([dir]);

    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "openclaw.plugin.json"), "utf-8"));
    expect(manifest.id).toBe("cool-plugin");
  });

  it("includes optional manifest fields when provided", async () => {
    const dir = path.join(tmpDir, "fancy");
    await runCli([dir, "--id", "fancy", "--name", "Fancy Plugin", "--description", "Does fancy things", "--kind", "memory"]);

    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "openclaw.plugin.json"), "utf-8"));
    expect(manifest.name).toBe("Fancy Plugin");
    expect(manifest.description).toBe("Does fancy things");
    expect(manifest.kind).toBe("memory");
  });

  it("rejects invalid plugin id", async () => {
    await runCli([tmpDir, "--id", ".."]);

    expect(runtime.error).toHaveBeenCalledWith("invalid plugin name: reserved path segment");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("rejects id with path separators", async () => {
    await runCli([tmpDir, "--id", "foo/bar"]);

    expect(runtime.error).toHaveBeenCalledWith("invalid plugin name: path separators not allowed");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("rejects invalid kind", async () => {
    const dir = path.join(tmpDir, "bad-kind");
    await runCli([dir, "--id", "test", "--kind", "nope"]);

    expect(runtime.error).toHaveBeenCalledWith("invalid kind: nope");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("refuses to overwrite existing files without --force", async () => {
    const dir = path.join(tmpDir, "existing");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), "{}", "utf-8");

    await runCli([dir, "--id", "existing"]);

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("already exists"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("overwrites with --force", async () => {
    const dir = path.join(tmpDir, "overwrite");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), "{}", "utf-8");
    fs.writeFileSync(path.join(dir, "index.ts"), "old", "utf-8");
    fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf-8");

    await runCli([dir, "--id", "overwrite", "--force"]);

    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "openclaw.plugin.json"), "utf-8"));
    expect(manifest.id).toBe("overwrite");
  });
});
