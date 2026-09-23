// Exercise the real definition inspector with files and native query responses.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { execFileUtf8 } from "./exec-file.js";
import {
  buildSystemdManagerPropertyOutput,
  buildSystemdUnitPropertyOutput,
} from "./service.test-helpers.js";
import { systemdManagerVersionProbe } from "./systemd-user-bus.test-support.js";
const system = vi.hoisted(() =>
  vi.fn<typeof import("./systemd-system.js").assertNoSystemSystemdOwnership>(),
);
const busctl = vi.hoisted(() => vi.fn<typeof import("./systemd-exec.js").execBusctlUser>());
vi.mock("./exec-file.js", () => ({ execFileUtf8: vi.fn() }));
vi.mock("./systemd-system.js", async (original) => ({
  ...(await original<typeof import("./systemd-system.js")>()),
  assertNoSystemSystemdOwnership: system,
}));
vi.mock("./systemd-exec.js", async (original) => ({
  ...(await original<typeof import("./systemd-exec.js")>()),
  execBusctlUser: busctl,
}));
import { readSystemdDefinitionMutationCapability } from "./systemd-definition-mutation.js";
afterEach(() => vi.restoreAllMocks());

it.skipIf(process.platform === "win32")(
  "inspects loaded-only definition authority without loading either manager",
  async () => {
    vi.mocked(execFileUtf8).mockReset().mockImplementation(systemdManagerVersionProbe);
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-definition-loaded-")),
    );
    const env = {
      HOME: path.join(root, "home"),
      XDG_RUNTIME_DIR: path.join(root, "runtime"),
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${root}/bus`,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_SYSTEMD_UNIT: "openclaw-owned",
    };
    const unitPath = path.join(env.HOME, ".config/systemd/user/openclaw-owned.service");
    try {
      await fs.mkdir(path.dirname(unitPath), { recursive: true, mode: 0o755 });
      await fs.mkdir(env.OPENCLAW_STATE_DIR, { mode: 0o700 });
      await fs.writeFile(unitPath, "[Service]\nExecStart=/usr/bin/node gateway\n", { mode: 0o644 });
      system.mockReset().mockResolvedValue(undefined);
      busctl.mockReset().mockImplementation(async (_env, args) => ({
        code: 0,
        termination: "exit",
        stderr: "",
        stdout:
          args.includes("GetUnit") || args.includes("LoadUnit")
            ? JSON.stringify({ type: "o", data: ["/org/freedesktop/systemd1/unit/owned"] })
            : args.includes("org.freedesktop.systemd1.Unit")
              ? buildSystemdUnitPropertyOutput({ fragmentPath: unitPath, loadState: "loaded" })
              : buildSystemdManagerPropertyOutput({
                  programArguments: ["/usr/bin/node", "gateway"],
                  environment: [],
                }),
      }));
      await expect(
        readSystemdDefinitionMutationCapability(env, { requireLoaded: true, timeoutMs: 1000 }),
      ).resolves.toEqual({ kind: "writable" });
      expect(system).toHaveBeenCalledWith("openclaw-owned.service", expect.any(Number), {
        requireLoaded: true,
      });
      expect(busctl.mock.calls.some(([, args]) => args.includes("LoadUnit"))).toBe(false);
      expect(busctl.mock.calls.every(([, args]) => args.includes("--auto-start=no"))).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "keeps a loaded, account-owned user unit writable when system ownership is unverifiable",
  async () => {
    const actual =
      await vi.importActual<typeof import("./systemd-system.js")>("./systemd-system.js");
    vi.mocked(execFileUtf8)
      .mockReset()
      .mockResolvedValue({ code: 1, termination: "exit", stdout: "", stderr: "denied" });
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const unverifiable = await actual
      .assertNoSystemSystemdOwnership("openclaw-owned.service", 1000)
      .then(
        () => undefined,
        (error: unknown) => error,
      )
      .finally(() => {
        if (platform) {
          Object.defineProperty(process, "platform", platform);
        }
      });
    expect(unverifiable).toMatchObject({ ownership: { status: "unverifiable" } });
    vi.mocked(execFileUtf8).mockReset().mockImplementation(systemdManagerVersionProbe);
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-definition-unverified-")),
    );
    const env = {
      HOME: path.join(root, "home"),
      XDG_RUNTIME_DIR: path.join(root, "runtime"),
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${root}/bus`,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_SYSTEMD_UNIT: "openclaw-owned",
    };
    const unitPath = path.join(env.HOME, ".config/systemd/user/openclaw-owned.service");
    try {
      await fs.mkdir(path.dirname(unitPath), { recursive: true, mode: 0o755 });
      await fs.mkdir(env.OPENCLAW_STATE_DIR, { mode: 0o700 });
      await fs.writeFile(unitPath, "[Service]\nExecStart=/usr/bin/node gateway\n", { mode: 0o644 });
      system.mockReset().mockRejectedValue(unverifiable);
      let loadState = "loaded";
      busctl.mockReset().mockImplementation(async (_env, args) => ({
        code: 0,
        termination: "exit",
        stderr: "",
        stdout:
          args.includes("GetUnit") || args.includes("LoadUnit")
            ? JSON.stringify({ type: "o", data: ["/org/freedesktop/systemd1/unit/owned"] })
            : args.includes("org.freedesktop.systemd1.Unit")
              ? buildSystemdUnitPropertyOutput({ fragmentPath: unitPath, loadState })
              : buildSystemdManagerPropertyOutput({
                  programArguments: ["/usr/bin/node", "gateway"],
                  environment: [],
                }),
      }));
      await expect(
        readSystemdDefinitionMutationCapability(env, { requireLoaded: true, timeoutMs: 1000 }),
      ).resolves.toEqual({ kind: "writable" });
      // Without the loaded requirement the unverifiable owner still fails closed.
      await expect(
        readSystemdDefinitionMutationCapability(env, { timeoutMs: 1000 }),
      ).resolves.toEqual({ kind: "unknown", reason: "system-ownership-unverified" });
      // A user unit that is not loaded cannot vouch for itself either.
      loadState = "not-found";
      await expect(
        readSystemdDefinitionMutationCapability(env, { requireLoaded: true, timeoutMs: 1000 }),
      ).resolves.toEqual({ kind: "unknown", reason: "system-ownership-unverified" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "admits user-unit activation past an unverifiable system probe only for a loaded, owned unit",
  async () => {
    const { assertNoSystemGatewayOwnershipForActivation } = await import("./systemd-scope.js");
    const actual =
      await vi.importActual<typeof import("./systemd-system.js")>("./systemd-system.js");
    vi.mocked(execFileUtf8)
      .mockReset()
      .mockResolvedValue({ code: 1, termination: "exit", stdout: "", stderr: "denied" });
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const unverifiable = await actual
      .assertNoSystemSystemdOwnership("openclaw-owned.service", 1000)
      .then(
        () => undefined,
        (error: unknown) => error,
      )
      .finally(() => {
        if (platform) {
          Object.defineProperty(process, "platform", platform);
        }
      });
    vi.mocked(execFileUtf8).mockReset().mockImplementation(systemdManagerVersionProbe);
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-activation-unverified-")),
    );
    const env = {
      HOME: path.join(root, "home"),
      XDG_RUNTIME_DIR: path.join(root, "runtime"),
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${root}/bus`,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_SYSTEMD_UNIT: "openclaw-owned",
    };
    const unitPath = path.join(env.HOME, ".config/systemd/user/openclaw-owned.service");
    try {
      await fs.mkdir(path.dirname(unitPath), { recursive: true, mode: 0o755 });
      await fs.mkdir(env.OPENCLAW_STATE_DIR, { mode: 0o700 });
      await fs.writeFile(unitPath, "[Service]\nExecStart=/usr/bin/node gateway\n", { mode: 0o644 });
      system.mockReset().mockRejectedValue(unverifiable);
      let loadState = "loaded";
      busctl.mockReset().mockImplementation(async (_env, args) => ({
        code: 0,
        termination: "exit",
        stderr: "",
        stdout:
          args.includes("GetUnit") || args.includes("LoadUnit")
            ? JSON.stringify({ type: "o", data: ["/org/freedesktop/systemd1/unit/owned"] })
            : args.includes("org.freedesktop.systemd1.Unit")
              ? buildSystemdUnitPropertyOutput({ fragmentPath: unitPath, loadState })
              : buildSystemdManagerPropertyOutput({
                  programArguments: ["/usr/bin/node", "gateway"],
                  environment: [],
                }),
      }));
      await expect(assertNoSystemGatewayOwnershipForActivation(env, 1000)).resolves.toBeUndefined();
      loadState = "not-found";
      await expect(assertNoSystemGatewayOwnershipForActivation(env, 1000)).rejects.toBe(
        unverifiable,
      );
      system.mockReset().mockRejectedValue(new Error("system-owned"));
      await expect(assertNoSystemGatewayOwnershipForActivation(env, 1000)).rejects.toThrow(
        "system-owned",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
