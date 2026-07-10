// Tests for the Claws CLI inspection and dry-run apply commands.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const logs: string[] = [];
  const errors: string[] = [];
  const runtime = {
    log: vi.fn((value: unknown) => logs.push(String(value))),
    error: vi.fn((value: unknown) => errors.push(String(value))),
    writeJson: vi.fn((value: unknown, space = 2) =>
      logs.push(JSON.stringify(value, null, space > 0 ? space : undefined)),
    ),
    writeStdout: vi.fn((value: string) =>
      logs.push(value.endsWith("\n") ? value.slice(0, -1) : value),
    ),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  };
  return { logs, errors, runtime };
});

vi.mock("../runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../runtime.js")>("../runtime.js")),
  defaultRuntime: mocks.runtime,
  writeRuntimeJson: (runtime: typeof mocks.runtime, value: unknown, space = 2) =>
    runtime.writeJson(value, space),
}));

const { registerClawsCli } = await import("./claws-cli.js");

async function writeManifest(value: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-claws-cli-"));
  const path = join(dir, "claw.json");
  await writeFile(path, JSON.stringify(value), "utf8");
  return path;
}

async function writeFeedWorkspace(params?: {
  feed?: unknown;
  manifest?: unknown;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-claws-cli-feed-"));
  const manifest = params?.manifest ?? {
    schemaVersion: "openclaw.claw.v1",
    id: "starter",
    name: "Starter",
    version: "1.0.0",
    entries: [
      {
        kind: "workspaceFile",
        id: "soul",
        path: "SOUL.md",
        source: "files/SOUL.md",
      },
    ],
  };
  const feed = params?.feed ?? {
    schemaVersion: "openclaw.clawFeed.v1",
    id: "local-starters",
    name: "Local Starters",
    entries: [
      {
        id: "starter",
        name: "Starter",
        version: "1.0.0",
        source: "starter.claw.json",
        owner: { type: "publisher", id: "openclaw.examples" },
      },
    ],
  };
  await writeFile(join(dir, "starter.claw.json"), JSON.stringify(manifest), "utf8");
  const feedPath = join(dir, "claws.feed.json");
  await writeFile(feedPath, JSON.stringify(feed), "utf8");
  return feedPath;
}

async function runCli(args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerClawsCli(program);
  try {
    await program.parseAsync(args, { from: "user" });
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith("__exit__:"))) {
      throw error;
    }
  }
}

describe("claws cli", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "1");
    mocks.logs.length = 0;
    mocks.errors.length = 0;
    mocks.runtime.log.mockClear();
    mocks.runtime.error.mockClear();
    mocks.runtime.writeJson.mockClear();
    mocks.runtime.exit.mockClear();
  });

  it("does not register the command when the experiment is disabled", () => {
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "");
    const program = new Command();

    registerClawsCli(program);

    expect(program.commands.map((command) => command.name())).not.toContain("claws");
  });

  it("prints JSON inspection for a local claw manifest", async () => {
    const manifestPath = await writeManifest({
      schemaVersion: "openclaw.claw.v1",
      id: "starter",
      name: "Starter",
      version: "1.0.0",
      entries: [
        {
          kind: "plugin",
          id: "example-plugin",
          selector: "npm:@openclaw/plugin-example@1.0.0",
        },
      ],
    });

    await runCli(["claws", "inspect", manifestPath, "--json"]);

    expect(mocks.runtime.writeJson).toHaveBeenCalledOnce();
    expect(mocks.runtime.writeJson.mock.calls[0][0]).toMatchObject({
      valid: true,
      manifest: {
        id: "starter",
        entries: [{ kind: "plugin", required: true }],
      },
    });
  });

  it("prints unsupported required entries in local dry-run apply previews", async () => {
    const manifestPath = await writeManifest({
      schemaVersion: "openclaw.claw.v1",
      id: "starter",
      name: "Starter",
      version: "1.0.0",
      entries: [
        {
          kind: "plugin",
          id: "bad-plugin",
          selector: "registry.example.com/plugin.tgz",
        },
      ],
    });

    await runCli(["claws", "apply", manifestPath, "--dry-run"]);

    expect(mocks.logs).toContain("Blocked entries: 1");
  });

  it("prints unsupported required entries in feed dry-run apply previews", async () => {
    const feedPath = await writeFeedWorkspace({
      manifest: {
        schemaVersion: "openclaw.claw.v1",
        id: "starter",
        name: "Starter",
        version: "1.0.0",
        entries: [
          {
            kind: "plugin",
            id: "bad-plugin",
            selector: "registry.example.com/plugin.tgz",
          },
        ],
      },
    });

    await runCli(["claws", "feed", "apply", feedPath, "starter", "--dry-run"]);

    expect(mocks.logs).toContain("Blocked entries: 1");
  });

  it("builds a dry-run JSON apply plan", async () => {
    const manifestPath = await writeManifest({
      schemaVersion: "openclaw.claw.v1",
      id: "starter",
      name: "Starter",
      version: "1.0.0",
      entries: [
        {
          kind: "plugin",
          id: "example-plugin",
          selector: "npm:@openclaw/plugin-example@1.0.0",
        },
        {
          kind: "workspaceFile",
          id: "soul",
          path: "SOUL.md",
          source: "files/SOUL.md",
        },
      ],
    });

    await runCli(["claws", "apply", manifestPath, "--dry-run", "--json"]);

    expect(mocks.runtime.writeJson).toHaveBeenCalledOnce();
    expect(mocks.runtime.writeJson.mock.calls[0][0]).toMatchObject({
      schemaVersion: "openclaw.clawApplyPlan.v1",
      dryRun: true,
      mutationAllowed: false,
      summary: { totalEntries: 2, installActions: 2, consentRequired: 1 },
      entries: [
        {
          id: "example-plugin",
          action: "installArtifact",
          rollback: { action: "uninstallArtifact" },
        },
        { id: "soul", action: "writeWorkspaceFile", consentRequired: true },
      ],
    });
  });

  it("requires --dry-run before apply can preview lifecycle actions", async () => {
    const manifestPath = await writeManifest({
      schemaVersion: "openclaw.claw.v1",
      id: "starter",
      name: "Starter",
      version: "1.0.0",
      entries: [],
    });

    await runCli(["claws", "apply", manifestPath]);

    expect(mocks.runtime.error).toHaveBeenCalledWith(
      "Claw apply is dry-run only in this OpenClaw build; pass --dry-run to preview lifecycle actions.",
    );
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("builds a dry-run JSON apply plan from a feed entry", async () => {
    const feedPath = await writeFeedWorkspace();

    await runCli(["claws", "feed", "apply", feedPath, "starter", "--dry-run", "--json"]);

    expect(mocks.runtime.writeJson).toHaveBeenCalledOnce();
    expect(mocks.runtime.writeJson.mock.calls[0][0]).toMatchObject({
      schemaVersion: "openclaw.clawApplyPlan.v1",
      dryRun: true,
      mutationAllowed: false,
      feed: { id: "local-starters", entry: { id: "starter" } },
      summary: { totalEntries: 1, consentRequired: 1, rollbackActions: 1 },
    });
  });

  it("prints JSON inspection for a local claw feed", async () => {
    const feedPath = await writeFeedWorkspace();

    await runCli(["claws", "feed", "inspect", feedPath, "--json"]);

    expect(mocks.runtime.writeJson).toHaveBeenCalledOnce();
    expect(mocks.runtime.writeJson.mock.calls[0][0]).toMatchObject({
      valid: true,
      feed: {
        id: "local-starters",
        entries: [{ id: "starter", owner: { type: "publisher" } }],
      },
    });
  });

  it("exits non-zero for invalid feed sources", async () => {
    const feedPath = await writeFeedWorkspace({
      feed: {
        schemaVersion: "openclaw.clawFeed.v1",
        id: "local-starters",
        name: "Local Starters",
        entries: [
          {
            id: "starter",
            name: "Starter",
            version: "1.0.0",
            source: "https://clawhub.ai/claws/starter.json",
            owner: { type: "publisher", id: "openclaw.examples" },
          },
        ],
      },
    });

    await runCli(["claws", "feed", "apply", feedPath, "starter", "--dry-run"]);

    expect(mocks.runtime.error).toHaveBeenCalled();
    expect(mocks.errors.join("\n")).toContain("unsupported_feed_source");
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("exits non-zero for invalid manifests", async () => {
    const manifestPath = await writeManifest({
      schemaVersion: "openclaw.claw.v1",
      id: "starter",
      name: "Starter",
      version: "1.0.0",
      entries: [{ kind: "plugin", id: "missing-selector" }],
    });

    await runCli(["claws", "inspect", manifestPath]);

    expect(mocks.runtime.error).toHaveBeenCalled();
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });
});
