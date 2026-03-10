import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import { SsrFBlockedError } from "../infra/net/ssrf.js";

const enqueueSystemEventMock = vi.fn();
const requestHeartbeatNowMock = vi.fn();
const loadConfigMock = vi.fn();
const fetchWithSsrFGuardMock = vi.fn();
const backupCreateCommandMock = vi.fn();
const cronLoggerDebugMock = vi.fn();
const cronLoggerErrorMock = vi.fn();
const cronLoggerInfoMock = vi.fn();
const cronLoggerWarnMock = vi.fn();

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
}));

vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow: (...args: unknown[]) => requestHeartbeatNowMock(...args),
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: () => loadConfigMock(),
  };
});

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
}));

vi.mock("../commands/backup.js", () => ({
  backupCreateCommand: (...args: unknown[]) => backupCreateCommandMock(...args),
}));

vi.mock("../logging.js", () => ({
  getChildLogger: () => ({
    debug: (...args: unknown[]) => cronLoggerDebugMock(...args),
    info: (...args: unknown[]) => cronLoggerInfoMock(...args),
    warn: (...args: unknown[]) => cronLoggerWarnMock(...args),
    error: (...args: unknown[]) => cronLoggerErrorMock(...args),
  }),
}));

import { buildGatewayCronService } from "./server-cron.js";

type TestDeps = CliDeps & {
  log: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
};

describe("buildGatewayCronService", () => {
  const deps = {
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as TestDeps;

  beforeEach(() => {
    enqueueSystemEventMock.mockClear();
    requestHeartbeatNowMock.mockClear();
    loadConfigMock.mockClear();
    fetchWithSsrFGuardMock.mockClear();
    backupCreateCommandMock.mockClear();
    cronLoggerDebugMock.mockClear();
    cronLoggerErrorMock.mockClear();
    cronLoggerInfoMock.mockClear();
    cronLoggerWarnMock.mockClear();
    deps.log.debug.mockClear();
    deps.log.info.mockClear();
    deps.log.warn.mockClear();
    deps.log.error.mockClear();
    backupCreateCommandMock.mockResolvedValue({
      archivePath: "/tmp/openclaw-backup.tar.gz",
      includeWorkspace: true,
      onlyConfig: false,
      verified: false,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("routes main-target jobs to the scoped session for enqueue + wake", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-${Date.now()}`);
    const cfg = {
      session: {
        mainKey: "main",
      },
      cron: {
        store: path.join(tmpDir, "cron.json"),
      },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "canonicalize-session-key",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        sessionKey: "discord:channel:ops",
        payload: { kind: "systemEvent", text: "hello" },
      });

      await state.cron.run(job.id, "force");

      expect(enqueueSystemEventMock).toHaveBeenCalledWith(
        "hello",
        expect.objectContaining({
          sessionKey: "agent:main:discord:channel:ops",
        }),
      );
      expect(requestHeartbeatNowMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:discord:channel:ops",
        }),
      );
    } finally {
      state.cron.stop();
    }
  });

  it("blocks private webhook URLs via SSRF-guarded fetch", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-ssrf-${Date.now()}`);
    const cfg = {
      session: {
        mainKey: "main",
      },
      cron: {
        store: path.join(tmpDir, "cron.json"),
      },
    } as OpenClawConfig;

    loadConfigMock.mockReturnValue(cfg);
    fetchWithSsrFGuardMock.mockRejectedValue(
      new SsrFBlockedError("Blocked: resolves to private/internal/special-use IP address"),
    );

    const state = buildGatewayCronService({
      cfg,
      deps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "ssrf-webhook-blocked",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello" },
        delivery: {
          mode: "webhook",
          to: "http://127.0.0.1:8080/cron-finished",
        },
      });

      await state.cron.run(job.id, "force");

      expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
        url: "http://127.0.0.1:8080/cron-finished",
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: expect.stringContaining('"action":"finished"'),
          signal: expect.any(AbortSignal),
        },
      });
    } finally {
      state.cron.stop();
    }
  });

  it("runs scheduled backup jobs through backupCreateCommand", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-backup-${Date.now()}`);
    const homeDir = path.join(tmpDir, "home");
    await fs.mkdir(homeDir, { recursive: true });
    vi.stubEnv("HOME", homeDir);
    vi.stubEnv("OPENCLAW_HOME", homeDir);
    const cfg = {
      session: {
        mainKey: "main",
      },
      cron: {
        store: path.join(tmpDir, "cron.json"),
      },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "scheduled-backup",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "main",
        wakeMode: "now",
        payload: {
          kind: "backupCreate",
          output: "daily/",
          includeWorkspace: false,
          verify: true,
        },
      });

      await state.cron.run(job.id, "force");

      expect(backupCreateCommandMock).toHaveBeenCalledWith(
        expect.objectContaining({
          log: expect.any(Function),
          error: expect.any(Function),
          exit: expect.any(Function),
        }),
        expect.objectContaining({
          output: expect.stringContaining(`${path.sep}Backups${path.sep}daily${path.sep}`),
          includeWorkspace: false,
          verify: true,
          signal: expect.any(AbortSignal),
        }),
      );
      const runtime = backupCreateCommandMock.mock.calls[0]?.[0] as {
        log: (message: string) => void;
        error: (message: string) => void;
      };
      runtime.log("archive created");
      runtime.error("non-fatal warning");
      expect(cronLoggerInfoMock).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: job.id, message: "archive created" }),
        "cron: backup log",
      );
      expect(cronLoggerWarnMock).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: job.id, message: "non-fatal warning" }),
        "cron: backup warning",
      );
      expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    } finally {
      state.cron.stop();
    }
  });

  it("continues scheduled backups when backup parent mkdir races with another run", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-backup-race-${Date.now()}`);
    const homeDir = path.join(tmpDir, "home");
    await fs.mkdir(homeDir, { recursive: true });
    vi.stubEnv("HOME", homeDir);
    vi.stubEnv("OPENCLAW_HOME", homeDir);
    const cfg = {
      session: {
        mainKey: "main",
      },
      cron: {
        store: path.join(tmpDir, "cron.json"),
      },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);

    const racedDir = path.join(homeDir, "Backups", "daily");
    const originalMkdir = fs.mkdir.bind(fs);
    let injectedRace = false;
    const mkdirSpy = vi
      .spyOn(fs, "mkdir")
      .mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
        const [target, options] = args;
        const resolvedTarget = path.resolve(String(target));
        if (!injectedRace && resolvedTarget === racedDir && options === undefined) {
          injectedRace = true;
          await originalMkdir(racedDir, { recursive: true });
          const err = new Error(
            `EEXIST: file already exists, mkdir '${racedDir}'`,
          ) as NodeJS.ErrnoException;
          err.code = "EEXIST";
          throw err;
        }
        return originalMkdir(target, options);
      });

    const state = buildGatewayCronService({
      cfg,
      deps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "scheduled-backup-mkdir-race",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "main",
        wakeMode: "now",
        payload: {
          kind: "backupCreate",
          output: `daily${path.sep}archive.tar.gz`,
          includeWorkspace: false,
          verify: true,
        },
      });

      await state.cron.run(job.id, "force");

      expect(injectedRace).toBe(true);
      expect(backupCreateCommandMock).toHaveBeenCalledWith(
        expect.objectContaining({
          log: expect.any(Function),
          error: expect.any(Function),
          exit: expect.any(Function),
        }),
        expect.objectContaining({
          output: path.join(homeDir, "Backups", "daily", "archive.tar.gz"),
          includeWorkspace: false,
          verify: true,
          signal: expect.any(AbortSignal),
        }),
      );
      expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    } finally {
      mkdirSpy.mockRestore();
      state.cron.stop();
    }
  });

  it("rejects scheduled backup outputs outside the backups directory", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-backup-output-${Date.now()}`);
    const homeDir = path.join(tmpDir, "home");
    await fs.mkdir(homeDir, { recursive: true });
    vi.stubEnv("HOME", homeDir);
    vi.stubEnv("OPENCLAW_HOME", homeDir);
    const cfg = {
      session: {
        mainKey: "main",
      },
      cron: {
        store: path.join(tmpDir, "cron.json"),
      },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "scheduled-backup-invalid-output",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "main",
        wakeMode: "now",
        payload: {
          kind: "backupCreate",
          output: "../../outside.tar.gz",
        },
      });

      await state.cron.run(job.id, "force");

      expect(backupCreateCommandMock).not.toHaveBeenCalled();
    } finally {
      state.cron.stop();
    }
  });

  it("rejects scheduled backup outputs that traverse through symlinked backup subdirectories", async () => {
    if (process.platform === "win32") {
      return;
    }

    const tmpDir = path.join(os.tmpdir(), `server-cron-backup-symlink-${Date.now()}`);
    const homeDir = path.join(tmpDir, "home");
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "server-cron-backup-outside-"));
    const backupsDir = path.join(homeDir, "Backups");
    const symlinkPath = path.join(backupsDir, `escaped-${Date.now()}`);
    const cfg = {
      session: {
        mainKey: "main",
      },
      cron: {
        store: path.join(tmpDir, "cron.json"),
      },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);

    await fs.mkdir(homeDir, { recursive: true });
    vi.stubEnv("HOME", homeDir);
    vi.stubEnv("OPENCLAW_HOME", homeDir);
    await fs.mkdir(backupsDir, { recursive: true });
    await fs.symlink(outsideDir, symlinkPath);

    const state = buildGatewayCronService({
      cfg,
      deps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "scheduled-backup-symlink-output",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "main",
        wakeMode: "now",
        payload: {
          kind: "backupCreate",
          output: `${path.basename(symlinkPath)}/subdir/target.tar.gz`,
        },
      });

      await state.cron.run(job.id, "force");

      expect(backupCreateCommandMock).not.toHaveBeenCalled();
      expect(await fs.stat(path.join(outsideDir, "subdir")).catch(() => undefined)).toBeUndefined();
    } finally {
      state.cron.stop();
      await fs.rm(symlinkPath, { force: true }).catch(() => undefined);
      await fs.rm(outsideDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
