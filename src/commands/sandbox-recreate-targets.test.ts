import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import {
  readBrowserRegistry,
  readRegistryEntry,
  updateBrowserRegistry,
  updateRegistry,
} from "../agents/sandbox/registry.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { sandboxListCommand, sandboxRecreateCommand } from "./sandbox.js";

const { spawnCommand } = vi.hoisted(() => ({ spawnCommand: vi.fn() }));
vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  spawnCommand,
}));

let stateDir: string | undefined;
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
  if (stateDir) {
    await fs.rm(stateDir, { recursive: true, force: true });
    stateDir = undefined;
  }
});

it.each([
  { browser: false, scope: "session" },
  { browser: false, scope: "agent" },
  { browser: true, scope: "session" },
  { browser: true, scope: "agent" },
] as const)(
  "recreates only $scope-selected runtimes (browser: $browser)",
  async ({ browser, scope }) => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-recreate-targets-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("CONTAINER_CONNECTION", undefined);
    vi.stubEnv("CONTAINER_SSHKEY", undefined);
    const oldUri = "unix:///tmp/old-podman.sock";
    const newUri = "unix:///tmp/new-podman.sock";
    vi.stubEnv("CONTAINER_HOST", oldUri);
    const image = "openclaw-sandbox:test";
    setRuntimeConfigSnapshot({
      agents: {
        defaults: { sandbox: { backend: "podman", docker: { image }, browser: { image } } },
      },
    });
    const entry = (name: string, uri: string) => ({
      containerName: `${name}-runtime`,
      backendId: "podman",
      backendTarget: {
        key: `socket:${createHash("sha256").update(uri).digest("hex").slice(0, 32)}`,
        globalArgs: ["--url", uri],
      },
      runtimeLabel: `${name}-runtime`,
      configLabelKind: "Image",
      sessionKey: `agent:${name}:current`,
      createdAtMs: 1,
      lastUsedAtMs: 1,
      image,
    });
    const oldEntry = entry("old", oldUri);
    const newEntry = entry("new", newUri);
    await updateRegistry(oldEntry);
    await updateRegistry(newEntry);
    for (const name of ["old", "new"]) {
      await updateBrowserRegistry({
        containerName: `${name}-browser`,
        sessionKey: `agent:${name}:current`,
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image,
        cdpPort: 9222,
      });
    }
    const physical = new Map([
      [oldUri, new Set([oldEntry.containerName])],
      [newUri, new Set([newEntry.containerName])],
      ["docker", new Set(["old-browser", "new-browser"])],
    ]);
    const calls: string[][] = [];
    spawnCommand.mockImplementation(async ([rawCommand, ...originalArgs]: string[]) => {
      const command = expectDefined(rawCommand, "container engine command");
      calls.push([command, ...originalArgs]);
      const args = [...originalArgs];
      let target = command === "docker" ? "docker" : process.env.CONTAINER_HOST!;
      if (args[0] === "--url") {
        target = expectDefined(args[1], "Podman --url value");
        args.splice(0, 2);
      }
      let stdout = "";
      if (args[0] === "info") {
        stdout = "true\ttrue\t\t5.0.0\n";
      } else if (args[0] === "system") {
        stdout = "[]";
      } else if (args[0] === "inspect") {
        expect(physical.get(target)?.has(args.at(-1)!)).toBe(true);
        if (args[2] === "{{.State.Running}}") {
          stdout = "true";
        } else if (args[2] === "{{.ImageName}}\t{{.Image}}") {
          stdout = `${image}\tsha256:fixture`;
        } else {
          expect(args[2]).toBe("{{.Config.Image}}");
          stdout = image;
        }
      } else if (args[0] === "rm") {
        expect(physical.get(target)?.delete(args.at(-1)!)).toBe(true);
      } else {
        throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      }
      return {
        failed: false,
        isCanceled: false,
        exitCode: 0,
        stdout: Buffer.from(stdout),
        stderr: Buffer.alloc(0),
      };
    });
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: (code: number): never => {
        throw new Error(`Unexpected CLI exit: ${code}`);
      },
    };
    const recreate = () =>
      sandboxRecreateCommand(
        {
          all: false,
          ...(scope === "session" ? { session: oldEntry.sessionKey } : { agent: "old" }),
          browser,
          force: true,
        },
        runtime,
      );

    // Global listing still reports target mismatches; selection must not turn a
    // selected runtime's failed target validation into permission to remove it.
    await expect(sandboxListCommand({ browser: false, json: true }, runtime)).rejects.toThrow(
      "active Podman connection changed",
    );
    if (!browser) {
      vi.stubEnv("CONTAINER_HOST", newUri);
      await expect(recreate()).rejects.toThrow("active Podman connection changed");
      expect(await readRegistryEntry(oldEntry.containerName)).toEqual(oldEntry);
      vi.stubEnv("CONTAINER_HOST", oldUri);
    }
    expect(calls.some((call) => call.includes("rm"))).toBe(false);
    calls.length = 0;
    await recreate();

    const removedName = browser ? "old-browser" : oldEntry.containerName;
    expect(calls.filter((call) => call.includes("rm"))).toEqual([
      browser
        ? ["docker", "rm", "-f", removedName]
        : ["podman", ...oldEntry.backendTarget.globalArgs, "rm", "-f", removedName],
    ]);
    expect(calls.every(([command]) => command === (browser ? "docker" : "podman"))).toBe(true);
    expect(calls.flat()).not.toContain(newEntry.containerName);
    expect(calls.flat()).not.toContain("new-browser");
    expect(physical.get(browser ? "docker" : oldUri)?.has(removedName)).toBe(false);
    expect(physical.get(newUri)?.has(newEntry.containerName)).toBe(true);
    expect(physical.get("docker")?.has("new-browser")).toBe(true);
    expect(await readRegistryEntry(newEntry.containerName)).toEqual(newEntry);
    expect(await readRegistryEntry(oldEntry.containerName)).toEqual(browser ? oldEntry : null);
    expect((await readBrowserRegistry()).entries.map(({ containerName }) => containerName)).toEqual(
      browser ? ["new-browser"] : ["new-browser", "old-browser"],
    );
  },
);
