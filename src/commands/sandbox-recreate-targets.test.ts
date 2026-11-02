import { createHash } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import {
  readBrowserRegistry,
  readRegistryEntry,
  updateBrowserRegistry,
  updateRegistry,
} from "../agents/sandbox/registry.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { sandboxListCommand, sandboxRecreateCommand } from "./sandbox.js";
import { createThrowingTestRuntime } from "./test-runtime-config-helpers.js";

const { spawnCommand } = vi.hoisted(() => ({ spawnCommand: vi.fn() }));
vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  spawnCommand,
}));

afterEach(clearRuntimeConfigSnapshot);

it.each([
  { browser: false, scope: "session" },
  { browser: false, scope: "agent" },
  { browser: true, scope: "session" },
  { browser: true, scope: "agent" },
] as const)(
  "recreates only $scope-selected runtimes (browser: $browser)",
  async ({ browser, scope }) => {
    const oldUri = "unix:///tmp/old-podman.sock";
    const newUri = "unix:///tmp/new-podman.sock";
    await withOpenClawTestState(
      {
        label: "recreate-targets",
        layout: "state-only",
        env: {
          CONTAINER_CONNECTION: undefined,
          CONTAINER_SSHKEY: undefined,
          CONTAINER_HOST: oldUri,
        },
      },
      async () => {
        const image = "openclaw-sandbox:test";
        const common = { createdAtMs: 1, lastUsedAtMs: 1, image };
        setRuntimeConfigSnapshot({
          agents: {
            defaults: { sandbox: { backend: "podman", docker: { image }, browser: { image } } },
          },
        });
        const entry = (name: string, uri: string) => ({
          ...common,
          containerName: `${name}-runtime`,
          backendId: "podman",
          backendTarget: {
            key: `socket:${createHash("sha256").update(uri).digest("hex").slice(0, 32)}`,
            globalArgs: ["--url", uri],
          },
          runtimeLabel: `${name}-runtime`,
          configLabelKind: "Image",
          sessionKey: `agent:${name}:current`,
        });
        const oldEntry = entry("old", oldUri);
        const newEntry = entry("new", newUri);
        await updateRegistry(oldEntry);
        await updateRegistry(newEntry);
        for (const name of ["old", "new"]) {
          await updateBrowserRegistry({
            ...common,
            containerName: `${name}-browser`,
            sessionKey: `agent:${name}:current`,
            cdpPort: 9222,
          });
        }
        const physical = new Map([
          [oldUri, new Set([oldEntry.containerName])],
          [newUri, new Set([newEntry.containerName])],
          ["docker", new Set(["old-browser", "new-browser"])],
        ]);
        const containerIds = new Map([
          [oldEntry.containerName, "1".repeat(64)],
          [newEntry.containerName, "2".repeat(64)],
          ["old-browser", "3".repeat(64)],
          ["new-browser", "4".repeat(64)],
        ]);
        const calls: string[][] = [];
        const success = { failed: false, isCanceled: false, exitCode: 0, stderr: Buffer.alloc(0) };
        const containerStateFormat =
          '{{.Id}}\n{{.State.Running}}\n{{.HostConfig.ReadonlyRootfs}}\n{{ index .Config.Labels "openclaw.configHash" }}';
        const responses: Record<string, string> = {
          info: "true\ttrue\t\t5.0.0\n",
          system: "[]",
          rm: "",
          "inspect:{{.State.Running}}": "true",
          "inspect:{{.ImageName}}\t{{.Image}}": `${image}\tsha256:fixture`,
          "inspect:{{.Config.Image}}": image,
        };
        spawnCommand.mockImplementation(async (argv: string[]) => {
          const [rawCommand, ...args] = argv;
          const command = expectDefined(rawCommand, "container engine command");
          calls.push(argv);
          let target = command === "docker" ? "docker" : process.env.CONTAINER_HOST!;
          if (args[0] === "--url") {
            target = expectDefined(args[1], "Podman --url value");
            args.splice(0, 2);
          }
          expect(["info", "system", "inspect", "rm"]).toContain(args[0]);
          if (args[0] === "inspect") {
            expect(physical.get(target)?.has(args.at(-1)!)).toBe(true);
          } else if (args[0] === "rm") {
            expect(physical.get(target)?.delete(args.at(-1)!)).toBe(true);
          }
          const key = args[0] === "inspect" ? `inspect:${args[2]}` : args[0];
          const stdout =
            key === `inspect:${containerStateFormat}`
              ? `${expectDefined(containerIds.get(args.at(-1)!), "synthetic container ID")}\ntrue\nfalse\n\n`
              : expectDefined(responses[key!], "supported container command/format");
          return { ...success, stdout: Buffer.from(stdout) };
        });
        const runtime = createThrowingTestRuntime();
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
          process.env.CONTAINER_HOST = newUri;
          await expect(recreate()).rejects.toThrow("active Podman connection changed");
          expect(await readRegistryEntry(oldEntry.containerName)).toEqual(oldEntry);
          process.env.CONTAINER_HOST = oldUri;
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
        expect(await readRegistryEntry(newEntry.containerName)).toEqual(newEntry);
        expect(await readRegistryEntry(oldEntry.containerName)).toEqual(browser ? oldEntry : null);
        expect(
          (await readBrowserRegistry()).entries.map(({ containerName }) => containerName),
        ).toEqual(browser ? ["new-browser"] : ["new-browser", "old-browser"]);
      },
    );
  },
);
