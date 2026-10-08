import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { defaultRuntime } from "../../runtime.js";
import { prepareDesktopRuntimeReceipt } from "./install-receipt.js";
import { createDaemonActionContext } from "./response.js";
import type { DaemonStatus } from "./status.gather.js";
import type { DaemonInstallOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  readOwnerAndDacl: vi.fn(),
  waitForGatewayDiagnosticReadiness: vi.fn(),
  gatherDaemonStatus: vi.fn(),
  isUpdateOwnedGatewayServiceCommand: vi.fn(),
}));
vi.mock("@openclaw/fs-safe/permissions", () => ({ readOwnerAndDacl: mocks.readOwnerAndDacl }));
vi.mock("./diagnostic-readiness.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./diagnostic-readiness.js")>()),
  waitForGatewayDiagnosticReadiness: mocks.waitForGatewayDiagnosticReadiness,
}));
vi.mock("./status.gather.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./status.gather.js")>()),
  gatherDaemonStatus: mocks.gatherDaemonStatus,
}));
vi.mock("../../daemon/service-update-authority.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service-update-authority.js")>()),
  isUpdateOwnedGatewayServiceCommand: mocks.isUpdateOwnedGatewayServiceCommand,
}));

const NONCE = "9372cfc7-052d-4c73-b574-41cd568a7aaf";
const USER_SID = "s-1-5-21-123-456-789-1001";
const privateDacl = () => ({
  status: "supported" as const,
  ownerSid: USER_SID,
  currentUserSid: USER_SID,
  isLocal: true,
  daclPresent: true,
  complete: true,
  unsupportedAceTypes: [],
  aces: [USER_SID, "s-1-5-18", "s-1-5-32-544"].map((sid) => ({
    sid,
    aceType: "allow" as const,
    mask: 0x1f01ff,
    flags: { inheritOnly: false },
  })),
});

describe("desktop runtime receipt", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let home: string;
  let target: string;
  let opts: DaemonInstallOptions;
  let pending: Record<string, unknown>;
  const read = () => JSON.parse(fs.readFileSync(target, "utf8"));

  beforeEach(() => {
    const account = os.userInfo();
    home = tempDirs.make("openclaw-desktop-receipt-");
    vi.spyOn(os, "userInfo").mockReturnValue({ ...account, homedir: home });
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv("OPENCLAW_WRAPPER", "");
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "");
    mocks.isUpdateOwnedGatewayServiceCommand.mockReturnValue(false);
    mocks.readOwnerAndDacl.mockImplementation(privateDacl);
    mocks.waitForGatewayDiagnosticReadiness.mockResolvedValue({ healthy: true });
    mocks.gatherDaemonStatus.mockReset();
    target = path.join(home, ".openclaw", "desktop-runtime-actions", NONCE, "result.json");
    const expectedRuntimePin = { revision: "captured-pin", definition: "captured-task" };
    opts = {
      json: true,
      force: true,
      runtime: "bun",
      runtimePath: "C:\\Users\\Owner\\.openclaw\\runtimes\\fork\\bun.exe",
      expectedRuntimePin: JSON.stringify(expectedRuntimePin),
      desktopRuntimeReceipt: JSON.stringify({ path: target, nonce: NONCE }),
    };
    pending = {
      version: 1,
      kind: "openclaw-desktop-runtime",
      phase: "pending",
      nonce: NONCE,
      request: { runtime: "bun", runtimePath: opts.runtimePath, expectedRuntimePin },
    };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(pending));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  function prepare() {
    const receipt = prepareDesktopRuntimeReceipt(opts);
    expect(receipt).toBeDefined();
    return receipt!;
  }

  it("preserves the stale-pin refusal from the install entry point without service writes", async () => {
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, ".openclaw"));
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(home, ".openclaw", "openclaw.json"));
    const native = await import("../../daemon/service.js");
    const pinState = await import("../../daemon/runtime-pin-state.js");
    const startup = await import("../program/config-guard.js");
    const initial = {
      programArguments: ["C:\\Node\\node.exe", "C:\\OpenClaw\\index.js", "gateway"],
    };
    const scope = { kind: "gateway" as const, env: process.env };
    const captured = pinState.readDaemonRuntimePinForInstall(scope, initial, true);
    const expectedRuntimePin = { revision: captured.revision, definition: captured.definition };
    opts.expectedRuntimePin = JSON.stringify(expectedRuntimePin);
    pending.request = { runtime: "bun", runtimePath: opts.runtimePath, expectedRuntimePin };
    fs.writeFileSync(target, JSON.stringify(pending));
    const newer = {
      programArguments: ["C:\\NewNode\\node.exe", "C:\\OpenClaw\\index.js", "gateway"],
    };
    const service = {
      ...native.resolveGatewayService(),
      readCommand: vi.fn(async () => newer),
      isLoaded: vi.fn(async () => true),
      install: vi.fn(async () => {}),
      stage: vi.fn(async () => {}),
    };
    vi.spyOn(native, "resolveGatewayService").mockReturnValue(service);
    const configPreparation = vi.spyOn(startup, "ensureConfigReady");
    const stdout = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {
      throw new Error("install refused");
    });
    const { runDaemonInstall } = await import("./install.js");

    await expect(runDaemonInstall(opts)).rejects.toThrow("install refused");

    const error =
      "Gateway service or runtime pin changed before installation. The newer selection was preserved; inspect it before retrying.";
    expect(stdout).toHaveBeenCalledWith(
      expect.objectContaining({ action: "install", ok: false, error }),
    );
    expect(read()).toMatchObject({
      phase: "complete",
      install: { action: "install", ok: false, error },
      observation: null,
    });
    expect(service.readCommand).toHaveBeenCalledOnce();
    expect(service.install).not.toHaveBeenCalled();
    expect(service.stage).not.toHaveBeenCalled();
    expect(configPreparation).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(home, ".openclaw", "openclaw.json"))).toBe(false);
    expect(pinState.readDaemonRuntimePinForInstall(scope, newer, true)).toEqual({
      ...captured,
      definition: expect.any(String),
    });
  });

  it("keeps the admitted file and publishes only the canonical result and minimal status", async () => {
    const identity = fs.statSync(target).ino;
    const events: string[] = [];
    mocks.waitForGatewayDiagnosticReadiness.mockImplementationOnce(async () => {
      events.push("readiness");
      return { healthy: true };
    });
    const observed: DaemonStatus = {
      service: {
        label: "Scheduled Task",
        loaded: true,
        loadState: { status: "loaded" },
        loadedText: "registered",
        notLoadedText: "missing",
        command: {
          programArguments: [
            opts.runtimePath!,
            "C:\\OpenClaw\\index.js",
            "gateway",
            "--token",
            "private-token",
          ],
          workingDirectory: "C:\\OpenClaw",
          environment: { OPENCLAW_GATEWAY_TOKEN: "private-token", PRIVATE_VALUE: "private-env" },
        },
        runtime: { status: "running", pid: 123 },
        runtimeIntent: {
          status: "known",
          revision: "new-pin",
          definition: "new-task",
          stored: true,
          pin: { runtime: "bun", path: opts.runtimePath! },
        },
        revision: "new-service",
        definitionMutation: "writable",
        launcherOverridden: false,
        targetRole: "target",
      },
      config: {
        cli: { path: "C:\\config.json", exists: true, valid: true },
        daemon: { path: "C:\\config.json", exists: true, valid: true },
      },
      gateway: {
        port: 18789,
        bindMode: "loopback",
        bindHost: "127.0.0.1",
        portSource: "service args",
        probeUrl: "ws://127.0.0.1:18789",
      },
      port: {
        port: 18789,
        status: "busy",
        listeners: [{ pid: 123, ppid: 456, commandLine: "private-command", user: "private-user" }],
        hints: ["private-hint"],
      },
      rpc: { ok: true, error: "private-error", url: "ws://private-url" },
      extraServices: [],
    };
    mocks.gatherDaemonStatus.mockImplementationOnce(async () => {
      events.push("status");
      return observed;
    });
    const receipt = prepare();
    try {
      await receipt.observe({}, 18789);
      receipt.emit({
        action: "install",
        ok: true,
        result: "installed",
        warnings: ["private-warning"],
      });
      expect(fs.statSync(target).ino).toBe(identity);
      expect(read()).toMatchObject({
        ...pending,
        phase: "complete",
        install: { action: "install", ok: true, result: "installed" },
        observation: {
          service: { runtime: { status: "running", pid: 123 }, revision: "new-service" },
          config: { daemon: { path: "C:\\config.json" } },
          gateway: { port: 18789 },
          port: { status: "busy", listeners: [{ pid: 123, ppid: 456 }] },
          rpc: { ok: true },
        },
      });
      expect(fs.readFileSync(target, "utf8")).not.toContain("private-");
      expect(events).toEqual(["readiness", "status"]);
      expect(mocks.gatherDaemonStatus).toHaveBeenCalledWith({
        rpc: {},
        probe: true,
        requireRpc: true,
        deep: true,
      });
      expect(mocks.waitForGatewayDiagnosticReadiness).toHaveBeenCalledWith({
        config: {},
        localPortOverride: 18789,
        ignoreEnvUrlOverride: true,
        serviceMode: "native",
        timeoutMs: 600_000,
      });
      expect(() => receipt.emit({ action: "install", ok: true })).toThrow();
    } finally {
      receipt.close();
    }
    expect(() => prepareDesktopRuntimeReceipt(opts)).toThrow();
  });

  it("writes a sanitized failure synchronously before the canonical action exits", () => {
    const receipt = prepare();
    const exit = new Error("test exit");
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {
      expect(read()).toMatchObject({
        phase: "complete",
        install: { ok: false },
        observation: null,
      });
      expect(fs.readFileSync(target, "utf8")).not.toContain("private-token");
      throw exit;
    });
    try {
      const context = createDaemonActionContext({
        action: "install",
        json: true,
        resultSink: receipt.emit,
      });
      expect(() => context.fail("raw diagnostic private-token")).toThrow(exit);
    } finally {
      receipt.close();
    }
  });

  it.each([
    {
      error:
        "Gateway install failed: Error: Runtime pin changed during service planning; rerun the install.",
      phase: "before",
    },
    {
      error:
        "Gateway install failed: Error: SERVICE_DEFINITION_UNKNOWN: Service definition refresh failed; the previous definition was left unchanged: Error: Managed service changed during runtime pin planning; rerun the install.",
      phase: "before",
    },
    {
      error:
        "Gateway install failed: Error: SERVICE_DEFINITION_UNKNOWN: Service definition inspection or backup failed; the definition was preserved: Error: Gateway service definition changed during inspection.",
      phase: "before",
    },
    {
      error:
        "Gateway install failed: Error: SERVICE_DEFINITION_UNKNOWN: Service definition changed: C:\\private-token\\gateway.cmd",
      phase: "during",
    },
    {
      error: "Gateway install failed: Error: SERVICE_DEFINITION_UNKNOWN: Scheduled Task changed.",
      phase: "during",
    },
    {
      error:
        "Gateway install failed: Error: Runtime pin changed before persistence; service may have changed, rerun install with an explicit runtime selection.",
      phase: "during",
    },
    {
      error:
        "Gateway install failed: Error: SERVICE_DEFINITION_UNKNOWN: Service definition refresh failed; the previous definition was restored: Error: Runtime pin changed during service planning; rerun the install.",
      phase: "before",
    },
    {
      error:
        "Gateway install failed: Error: SERVICE_DEFINITION_UNKNOWN: Service definition refresh failed; the previous definition was restored: Error: SERVICE_DEFINITION_UNKNOWN: Scheduled Task changed.",
      phase: "during",
    },
    {
      error:
        "Gateway install failed: Error: Runtime pin changed during service planning; rerun the install. private-token",
      phase: "unknown",
    },
  ])("projects known $phase conflict guidance without raw diagnostics", ({ error, phase }) => {
    const receipt = prepare();
    try {
      receipt.emit({ action: "install", ok: false, error });
      expect(read().install.error).toBe(
        phase === "before"
          ? "Gateway service or runtime pin changed before installation. The newer selection was preserved; inspect it before retrying."
          : phase === "during"
            ? "Gateway service or runtime pin changed during installation. Inspect the current definition and runtime pin before retrying; no automatic retry was attempted."
            : "Gateway runtime installation failed. Inspect openclaw gateway status --deep before retrying; no automatic retry was attempted.",
      );
      expect(fs.readFileSync(target, "utf8")).not.toContain("private-token");
    } finally {
      receipt.close();
    }
  });

  it.each([
    {
      name: "restored definition after the native publish failure",
      error:
        "Gateway install failed: Error: SERVICE_DEFINITION_UNKNOWN: Service definition refresh failed; the previous definition was restored: Error: EPERM: operation not permitted, rename 'C:\\private-token\\.gateway.cmd.tmp' -> 'C:\\private-token\\gateway.cmd'",
      outcome: "restored",
    },
    {
      name: "unchanged definition after failed refresh",
      error:
        "Gateway install failed: Error: SERVICE_DEFINITION_UNKNOWN: Service definition refresh failed; the previous definition was left unchanged: Error: private-token",
      outcome: "left unchanged",
    },
    {
      name: "preserved definition after failed backup",
      error:
        "Gateway install failed: Error: SERVICE_DEFINITION_UNKNOWN: Service definition inspection or backup failed; the definition was preserved: Error: EACCES private-token",
      outcome: "left unchanged",
    },
    {
      name: "outer unchanged outcome despite nested restored text",
      error:
        "Gateway install failed: Error: SERVICE_DEFINITION_UNKNOWN: Service definition refresh failed; the previous definition was left unchanged: SERVICE_DEFINITION_UNKNOWN: Service definition refresh failed; the previous definition was restored: Error: private-token",
      outcome: "left unchanged",
    },
    {
      name: "outer restored outcome despite nested unchanged text",
      error:
        "Gateway install failed: Error: SERVICE_DEFINITION_UNKNOWN: Service definition refresh failed; the previous definition was restored: SERVICE_DEFINITION_UNKNOWN: Service definition refresh failed; the previous definition was left unchanged: Error: private-token",
      outcome: "restored",
    },
    {
      name: "unverified recovery containing nested restored text",
      error:
        "Gateway install failed: GatewayServiceAuthorityError: UPDATE_NATIVE_AUTHORITY: Service definition recovery is unverified: private-token SERVICE_DEFINITION_UNKNOWN: Service definition refresh failed; the previous definition was restored: Error: private-token",
      outcome: "unknown",
    },
    {
      name: "unrecognized outer failure containing restored text",
      error:
        "Gateway install failed: Error: private-token SERVICE_DEFINITION_UNKNOWN: Service definition refresh failed; the previous definition was restored: Error: private-token",
      outcome: "unknown",
    },
    {
      name: "unresolved failure beyond the wrapper limit",
      error:
        "Error: ".repeat(5) +
        "SERVICE_DEFINITION_UNKNOWN: Service definition refresh failed; the previous definition was restored: private-token",
      outcome: "unknown",
    },
    {
      name: "near-match recovery wrapper",
      error:
        "Gateway install failed: Error: SERVICE_DEFINITION_UNKNOWN: Service definition refresh failed; the previous definition was restored unexpectedly: private-token",
      outcome: "unknown",
    },
  ])("projects only the safe $name", ({ error, outcome }) => {
    const receipt = prepare();
    try {
      receipt.emit({ action: "install", ok: false, error, warnings: ["private-warning"] });
      const result = read();
      expect(result.install.error).toBe(
        `Gateway runtime installation failed. ${outcome === "unknown" ? "" : `The previous service definition was ${outcome}. `}Inspect openclaw gateway status --deep before retrying; no automatic retry was attempted.`,
      );
      expect(result.install.ok).toBe(false);
      expect(result.observation).toBeNull();
      expect(fs.readFileSync(target, "utf8")).not.toContain("private-");
    } finally {
      receipt.close();
    }
  });

  it("does not publish another service action as an install receipt", () => {
    const receipt = prepare();
    try {
      expect(() => receipt.emit({ action: "restart", ok: true })).toThrow();
      expect(read()).toEqual(pending);
    } finally {
      receipt.close();
    }
  });

  it.each(["readiness", "status"])(
    "makes failed %s observation explicit without copying diagnostics",
    async (stage) => {
      const failure = new Error("ws://private-auth?token=private-token");
      if (stage === "readiness") {
        mocks.waitForGatewayDiagnosticReadiness.mockRejectedValueOnce(failure);
      } else {
        mocks.gatherDaemonStatus.mockRejectedValueOnce(failure);
      }
      const receipt = prepare();
      try {
        await receipt.observe({}, 18789);
        receipt.emit({ action: "install", ok: true, result: "installed" });
        expect(read()).toMatchObject({
          install: { ok: true },
          observation: null,
          observationError: expect.stringContaining("could not be verified"),
        });
        expect(fs.readFileSync(target, "utf8")).not.toContain("private-");
      } finally {
        receipt.close();
      }
    },
  );

  it.each([
    ["force", false],
    ["json", false],
    ["runtime", "node"],
    ["runtimePath", "relative.exe"],
    ["expectedRuntimePin", undefined],
    ["restoreServiceCli", "{}"],
    ["wrapper", "C:\\wrapper.exe"],
  ] as const)("rejects incompatible %s before touching the file", (key, value) => {
    const before = fs.readFileSync(target);
    expect(() => prepareDesktopRuntimeReceipt({ ...opts, [key]: value })).toThrow();
    expect(fs.readFileSync(target)).toEqual(before);
  });

  it.each(["platform", "update-owned", "update-env", "wrapper-env"])(
    "rejects %s invocation",
    (variant) => {
      if (variant === "platform") {
        vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      }
      if (variant === "update-owned") {
        mocks.isUpdateOwnedGatewayServiceCommand.mockReturnValue(true);
      }
      if (variant === "update-env") {
        vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
      }
      if (variant === "wrapper-env") {
        vi.stubEnv("OPENCLAW_WRAPPER", "C:\\wrapper.exe");
      }
      expect(() => prepareDesktopRuntimeReceipt(opts)).toThrow();
      expect(read()).toEqual(pending);
    },
  );

  it.each(["nonce", "request", "complete", "fresh-service", "oversize"])(
    "rejects an invalid %s marker without overwriting it",
    (variant) => {
      if (variant === "nonce") {
        pending.nonce = "3584d73e-1762-4a99-96e1-364a95c9a200";
      }
      if (variant === "request") {
        pending.request = { ...(pending.request as object), runtimePath: "C:\\other.exe" };
      }
      if (variant === "complete") {
        pending.phase = "complete";
      }
      if (variant === "fresh-service") {
        opts.expectedRuntimePin = JSON.stringify({ revision: "empty", definition: null });
      }
      fs.writeFileSync(
        target,
        variant === "oversize" ? " ".repeat(1024 * 1024 + 1) : JSON.stringify(pending),
      );
      const before = fs.readFileSync(target);
      expect(() => prepareDesktopRuntimeReceipt(opts)).toThrow();
      expect(fs.readFileSync(target)).toEqual(before);
    },
  );

  it("does not use HOME or USERPROFILE to admit an arbitrary destination", () => {
    const otherHome = tempDirs.make("openclaw-fake-profile-");
    vi.stubEnv("HOME", otherHome);
    vi.stubEnv("USERPROFILE", otherHome);
    opts.desktopRuntimeReceipt = JSON.stringify({
      path: target.replace(home, otherHome),
      nonce: NONCE,
    });
    expect(() => prepareDesktopRuntimeReceipt(opts)).toThrow();
    expect(fs.readdirSync(otherHome)).toEqual([]);
    expect(read()).toEqual(pending);
  });

  it.each(["missing", "directory", "hardlink", "symlink", "ancestor-symlink"])(
    "refuses a %s target without creating or changing a file",
    (variant) => {
      const retained = path.join(home, "retained.json");
      fs.renameSync(target, retained);
      if (variant === "directory") {
        fs.mkdirSync(target);
      }
      if (variant === "hardlink") {
        fs.linkSync(retained, target);
      }
      if (variant === "symlink") {
        fs.symlinkSync(retained, target);
      }
      if (variant === "ancestor-symlink") {
        const actionDir = path.dirname(target);
        const moved = path.join(home, "moved-action");
        fs.renameSync(actionDir, moved);
        fs.copyFileSync(retained, path.join(moved, "result.json"));
        fs.symlinkSync(moved, actionDir, "junction");
      }
      expect(() => prepareDesktopRuntimeReceipt(opts)).toThrow();
      expect(JSON.parse(fs.readFileSync(retained, "utf8"))).toEqual(pending);
      if (variant === "missing") {
        expect(fs.existsSync(target)).toBe(false);
      }
    },
  );

  it.each(["owner", "remote", "null-dacl", "incomplete", "other-user"])(
    "rejects %s security facts",
    (variant) => {
      const facts = privateDacl();
      if (variant === "owner") {
        facts.ownerSid = "s-1-5-21-123-456-789-1002";
      }
      if (variant === "remote") {
        facts.isLocal = false;
      }
      if (variant === "null-dacl") {
        facts.daclPresent = false;
      }
      if (variant === "incomplete") {
        facts.complete = false;
      }
      if (variant === "other-user") {
        facts.aces.push({ ...facts.aces[0]!, sid: "s-1-1-0" });
      }
      mocks.readOwnerAndDacl.mockReturnValue(facts);
      expect(() => prepareDesktopRuntimeReceipt(opts)).toThrow();
      expect(read()).toEqual(pending);
    },
  );

  it.each(["contents", "replacement", "permissions", "hardlink"])(
    "refuses a %s change after admission without overwriting the new state",
    (variant) => {
      const receipt = prepare();
      try {
        if (variant === "contents") {
          fs.writeFileSync(target, "newer selection");
        }
        if (variant === "replacement") {
          fs.renameSync(target, path.join(home, "previous.json"));
          fs.writeFileSync(target, "unrelated replacement");
        }
        if (variant === "permissions") {
          mocks.readOwnerAndDacl.mockReturnValue({ ...privateDacl(), ownerSid: "s-1-5-18" });
        }
        if (variant === "hardlink") {
          fs.linkSync(target, path.join(home, "additional-link.json"));
        }
        const before = fs.readFileSync(target);
        expect(() => receipt.emit({ action: "install", ok: true })).toThrow();
        expect(fs.readFileSync(target)).toEqual(before);
      } finally {
        receipt.close();
      }
    },
  );
});
