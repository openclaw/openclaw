import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const defaults = vi.hoisted(() => ({
  phase: "initializing",
  mounted: true,
  nested: false,
  wrongBacking: false,
  unmountFails: false,
  removed: false,
  outputAllocated: false,
  candidateCreated: false,
  helperMissing: false,
  readyConfigurations: false,
  networkCommand: "slirp4netns",
}));
const fixture = vi.hoisted(() => ({ ...defaults, root: "", calls: [] as string[] }));
const filesystems = (...entries: object[]) => ({ filesystems: entries });
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    appendFileSync: () => {},
    writeFileSync: () => {},
    mkdirSync: () => {
      fixture.outputAllocated = true;
    },
    chmodSync: () => {},
    mkdtempSync: () => path.join(fixture.root, "scratch"),
    realpathSync: (value: string) => value,
    lstatSync: () => ({ isFile: () => true, uid: 1000, mode: 0o600 }),
    statSync: () => ({ size: 32 * 1024 ** 3, uid: 1000, mode: 0o600, isSocket: () => true }),
    readFileSync: (file: string) => {
      if (fixture.readyConfigurations) {
        const mount = path.join(fixture.root, "volume");
        const configs: Record<string, string> = {
          "storage.conf": `[storage]\ndriver = "overlay"\nrunroot = "${mount}/runroot"\ngraphroot = "${mount}/graphroot"\n`,
          "containers.conf":
            '[containers]\nlog_driver = "k8s-file"\nlog_size_max = 1048576\n[network]\ndefault_rootless_network_cmd = "slirp4netns"\n',
        };
        const config = Object.keys(configs).find((suffix) => file.endsWith(suffix));
        if (config) {
          return configs[config];
        }
      }
      if (!file.endsWith("manifest.json")) {
        throw new Error("Configuration is not initialized");
      }
      return JSON.stringify({
        schema: "mantis.podman-storage.v1",
        root: fixture.root,
        uid: 1000,
        gid: 1000,
        bytes: 32 * 1024 ** 3,
        phase: fixture.phase,
      });
    },
    rmSync: () => {
      fixture.removed = true;
    },
  };
});
vi.mock("node:child_process", async (original) => {
  const child = await original<typeof import("node:child_process")>();
  return {
    ...child,
    spawnSync: () => ({ status: fixture.mounted ? 0 : 1 }),
    execFileSync: (name: string, args: string[]) => {
      fixture.calls.push(`${name} ${args.join(" ")}`);
      const mount = path.join(fixture.root, "volume");
      const operation =
        name === "findmnt"
          ? ["--mountpoint", "--list", "--target"].find((flag) => args.includes(flag))
          : args[0];
      const command = ["podman", "sudo", "git", "findmnt"].includes(name)
        ? `${name} ${operation}`
        : name;
      const failures: Record<string, string> = {
        fallocate: "Allocation failed: no space left",
        "sudo mount": "Mount reached without backing reservation",
        "podman create": "Candidate creation reached without verified storage",
        ...(fixture.helperMissing ? { slirp4netns: "Required networking helper unavailable" } : {}),
        ...(fixture.unmountFails ? { "sudo umount": "Mount has live holders" } : {}),
      };
      if (command === "podman create") {
        fixture.candidateCreated = true;
      }
      if (failures[command]) {
        throw new Error(failures[command]);
      }
      if (command === "sudo umount") {
        fixture.mounted = false;
        return "";
      }
      const responses: Record<string, unknown> = {
        slirp4netns: "slirp4netns version 1.3.3",
        "mkfs.ext4": "",
        "git diff": "",
        "podman rm": "",
        "podman info": {
          host: {
            security: { rootless: true },
            logDriver: "k8s-file",
            rootlessNetworkCmd: fixture.networkCommand,
          },
          store: { graphRoot: `${mount}/graphroot`, runRoot: `${mount}/runroot` },
        },
        "sudo losetup": {
          loopdevices: [
            {
              name: "/dev/loop7",
              "back-file": fixture.wrongBacking
                ? "/unrelated.img"
                : path.join(fixture.root, "storage.img"),
            },
          ],
        },
        "findmnt --mountpoint": filesystems({
          target: mount,
          source: "/dev/loop7",
          fstype: "ext4",
        }),
        "findmnt --list": filesystems(
          { target: mount },
          ...(fixture.nested ? [{ target: path.join(mount, "nested") }] : []),
        ),
        "findmnt --target": filesystems({ target: "/" }),
      };
      if (!(command in responses)) {
        throw new Error(`Unexpected cleanup command: ${name}`);
      }
      const response = responses[command];
      return typeof response === "string" ? response : JSON.stringify(response);
    },
  };
});
const originalArgv = process.argv;
const cleanupPath = fileURLToPath(
  new URL("../../scripts/mantis/telegram-proof-storage.mts", import.meta.url),
);
const descriptors = ["getuid", "getgid", "platform"].map(
  (name) => [name, Object.getOwnPropertyDescriptor(process, name)] as const,
);
beforeEach(() => {
  vi.resetModules();
  process.argv = [process.execPath, cleanupPath, "cleanup"];
  Object.assign(fixture, defaults, { root: path.resolve("mantis-podman-fixture"), calls: [] });
  for (const name of ["getuid", "getgid"]) {
    Object.defineProperty(process, name, { configurable: true, value: () => 1000 });
  }
  vi.stubEnv("MANTIS_PODMAN_ROOT", fixture.root);
});
afterEach(() => {
  process.argv = originalArgv;
  for (const [name, descriptor] of descriptors) {
    if (descriptor) {
      Object.defineProperty(process, name, descriptor);
    } else {
      Reflect.deleteProperty(process, name);
    }
  }
  vi.unstubAllEnvs();
});
const loadStorage = () => import("../../scripts/mantis/telegram-proof-storage.mts");
function setup() {
  process.argv = [process.execPath, cleanupPath, "setup"];
  Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
}
function called(prefix: string) {
  return fixture.calls.some((call) => call.startsWith(prefix));
}
describe("interrupted mounted storage initialization", () => {
  it.each([
    [true, "Required networking helper unavailable", "fallocate "],
    [false, "Allocation failed: no space left", "sudo mount "],
  ] as const)("refuses setup on %s: %s", async (helperMissing, error, forbidden) => {
    fixture.helperMissing = helperMissing;
    setup();
    vi.stubEnv("RUNNER_TEMP", fixture.root);
    vi.stubEnv("GITHUB_ENV", path.join(fixture.root, "github-env"));
    await expect(loadStorage()).rejects.toThrow(error);
    expect({ forbidden: called(forbidden), candidateCreated: fixture.candidateCreated }).toEqual({
      forbidden: false,
      candidateCreated: false,
    });
  });
  it.each(["slirp4netns", "pasta"])(
    "verifies the actual rootless networking helper (%s)",
    async (networkCommand) => {
      fixture.phase = "ready";
      fixture.readyConfigurations = true;
      fixture.networkCommand = networkCommand;
      process.argv = [process.execPath, "fixture"];
      const storage = await loadStorage();
      for (const [key, value] of Object.entries(storage.proofStorageEnvironment())) {
        vi.stubEnv(key, value);
      }
      if (networkCommand === "slirp4netns") {
        expect(() => storage.assertPodmanProofStorage()).not.toThrow();
      } else {
        expect(() => storage.assertPodmanProofStorage()).toThrow(
          "Podman escaped bounded rootless storage",
        );
      }
    },
  );
  it("refuses Web candidate creation before bounded storage is ready", async () => {
    process.argv = [
      process.execPath,
      fileURLToPath(new URL("../../scripts/mantis/run-request-web-ui.mts", import.meta.url)),
      "a".repeat(40),
      path.join(fixture.root, "web-output"),
    ];
    await expect(import("../../scripts/mantis/run-request-web-ui.mts")).rejects.toThrow(
      "Proof storage initialization is incomplete",
    );
    expect(fixture).toMatchObject({ outputAllocated: false, candidateCreated: false });
  });
  it("unmounts verified initialization without requiring absent configs or user bus", async () => {
    await loadStorage();
    expect(fixture.removed).toBe(true);
    expect(fixture.calls).toContain(`sudo umount ${path.join(fixture.root, "volume")}`);
  });
  it.each(["nested", "wrongBacking", "unmountFails"] as const)(
    "retains storage on %s",
    async (failure) => {
      fixture[failure] = true;
      await expect(loadStorage()).rejects.toThrow();
      expect(fixture.removed).toBe(false);
    },
  );
  it("keeps ready cleanup strict when configurations disappear", async () => {
    fixture.phase = "ready";
    await expect(loadStorage()).rejects.toThrow("Configuration is not initialized");
    expect(fixture.removed).toBe(false);
    expect(called("sudo umount")).toBe(false);
  });
});
