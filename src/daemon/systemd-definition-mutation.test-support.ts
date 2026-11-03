// Shared mocks and lifecycle for the focused systemd-definition-mutation suites.
import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { execFileUtf8 } from "./exec-file.js";
import {
  buildSystemdManagerPropertyOutput,
  buildSystemdUnitPropertyOutput,
} from "./service.test-helpers.js";
import { stageSystemdService } from "./systemd-install.js";
import { systemdManagerVersionProbe } from "./systemd-user-bus.test-support.js";

const assertNoSystemOwnership = vi.hoisted(() =>
  vi.fn<typeof import("./systemd-system.js").assertNoSystemSystemdOwnership>(),
);

const busctl = vi.hoisted(() => vi.fn<typeof import("./systemd-exec.js").execBusctlUser>());

vi.mock("./exec-file.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./exec-file.js")>()),
  execFileUtf8: vi.fn(),
}));

vi.mock("./systemd-system.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./systemd-system.js")>()),
  assertNoSystemSystemdOwnership: assertNoSystemOwnership,
}));

vi.mock("./systemd-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./systemd-exec.js")>()),
  assertSystemdAvailable: async () => {},
  execBusctlUser: busctl,
  execSystemctlUser: async () => ({ code: 0, termination: "exit", stdout: "", stderr: "" }),
}));

// Safe fixture modes must not depend on umask; fault cases change permissions explicitly.
export const writeFixtureFile = (file: string, contents: string, options: { mode?: number } = {}) =>
  fs.writeFile(file, contents, { mode: 0o644, ...options });

export let root: string;

export let stateDir: string;

export let unitPath: string;

export let environmentPath: string;

export let env: Record<string, string>;

export const artifacts = [
  { artifact: "unit", select: () => unitPath },
  { artifact: "environment", select: () => environmentPath },
  { artifact: "backup", select: () => `${unitPath}.bak` },
];

export const stage = (environmentOverrides: Record<string, string> = {}) =>
  stageSystemdService({
    env,
    stdout: new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    }),
    programArguments: [
      "/usr/bin/node",
      "/srv/openclaw/dist/index.js",
      "gateway",
      "--port",
      "18789",
    ],
    environment: {
      OPENCLAW_GATEWAY_PORT: "18789",
      OPENCLAW_GATEWAY_TOKEN: "replacement-secret-canary",
      ...environmentOverrides,
    },
    environmentValueSources: {
      OPENCLAW_GATEWAY_PORT: "inline",
      OPENCLAW_GATEWAY_TOKEN: "file",
    },
  });

export function managerDefinition(
  fragmentPath: string,
  dropInPaths: string[] = [],
  environmentFiles: Array<[string, boolean]> = [],
  isLoaded = async () => true,
) {
  busctl.mockImplementation(async (_env, args) => {
    const loaded = await isLoaded();
    return {
      code: 0,
      termination: "exit",
      stderr: "",
      stdout: args.includes("LoadUnit")
        ? JSON.stringify({ type: "o", data: ["/org/freedesktop/systemd1/unit/owned"] })
        : args.includes("org.freedesktop.systemd1.Unit")
          ? buildSystemdUnitPropertyOutput({
              fragmentPath: loaded ? fragmentPath : "",
              dropInPaths: loaded ? dropInPaths : [],
              loadState: loaded ? "loaded" : "not-found",
            })
          : buildSystemdManagerPropertyOutput({
              programArguments: ["/usr/bin/node", "gateway"],
              environment: ["TOKEN=manager-secret-canary"],
              environmentFiles,
            }),
    };
  });
}

export function afterUnitTemporaryWrite(fault: () => void | Promise<void>) {
  const writeFile = fs.writeFile.bind(fs);
  vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
    await writeFile(...args);
    if (
      typeof args[0] === "string" &&
      args[0].startsWith(`${unitPath}.`) &&
      args[0].endsWith(".tmp")
    ) {
      await fault();
    }
  });
}

export async function expectNoTemporaryFiles(directory: string) {
  expect((await fs.readdir(directory)).filter((file) => file.endsWith(".tmp"))).toEqual([]);
}

export function setupSystemdDefinitionMutationFixture() {
  beforeEach(async () => {
    assertNoSystemOwnership.mockReset().mockResolvedValue(undefined);
    vi.mocked(execFileUtf8).mockReset().mockImplementation(systemdManagerVersionProbe);
    busctl.mockReset().mockImplementation(async (serviceEnv) => ({
      code: 1,
      termination: "exit",
      stdout: "",
      stderr: `Call failed: Unit ${serviceEnv.OPENCLAW_SYSTEMD_UNIT}.service not found.`,
    }));
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-definition-")));
    stateDir = path.join(root, "state");
    env = {
      HOME: path.join(root, "home"),
      XDG_RUNTIME_DIR: path.join(root, "runtime"),
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${root}/bus`,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_SYSTEMD_UNIT: "openclaw-owned",
    };
    unitPath = path.join(env.HOME!, ".config/systemd/user/openclaw-owned.service");
    environmentPath = path.join(stateDir, "gateway.systemd.env");
    await fs.mkdir(path.dirname(unitPath), { recursive: true, mode: 0o755 });
    await fs.mkdir(stateDir, { mode: 0o700 });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });
}

export { assertNoSystemOwnership, busctl };
