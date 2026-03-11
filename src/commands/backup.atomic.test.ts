import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";

const tarCreateMock = vi.hoisted(() => vi.fn());
const packInstances = vi.hoisted(() => [] as FakePack[]);
const backupVerifyCommandMock = vi.hoisted(() => vi.fn());
const pipelineMock = vi.hoisted(() => vi.fn());
const configurePackMock = vi.hoisted(() => vi.fn<(pack: FakePack) => void>());

class FakePack extends EventEmitter {
  readonly add = vi.fn<(path: string) => this>();
  readonly end = vi.fn<() => this>();
  readonly pipe = vi.fn<(dest: NodeJS.WritableStream) => NodeJS.WritableStream>();
  readonly destroy = vi.fn<(err?: Error) => this>();

  constructor() {
    super();
    this.add.mockImplementation(() => this);
    this.end.mockImplementation(() => this);
    this.pipe.mockImplementation((dest) => dest);
    this.destroy.mockImplementation((err?: Error) => {
      queueMicrotask(() => {
        if (err) {
          this.emit("error", err);
        }
      });
      return this;
    });
    configurePackMock(this);
  }
}

vi.mock("tar", () => ({
  c: tarCreateMock,
  Pack: class {
    constructor() {
      const pack = new FakePack();
      packInstances.push(pack);
      return pack;
    }
  },
}));

vi.mock("./backup-verify.js", () => ({
  backupVerifyCommand: backupVerifyCommandMock,
}));

vi.mock("node:stream/promises", async () => {
  const actual =
    await vi.importActual<typeof import("node:stream/promises")>("node:stream/promises");
  return {
    ...actual,
    pipeline: (...args: unknown[]) => {
      const mockImpl = pipelineMock.getMockImplementation();
      if (mockImpl) {
        return pipelineMock(...args);
      }
      return (actual.pipeline as (...pipelineArgs: unknown[]) => unknown)(...args);
    },
  };
});

const { backupCreateCommand } = await import("./backup.js");

describe("backupCreateCommand atomic archive write", () => {
  let tempHome: TempHomeEnv;

  beforeEach(async () => {
    tempHome = await createTempHomeEnv("openclaw-backup-atomic-test-");
    tarCreateMock.mockReset();
    packInstances.length = 0;
    backupVerifyCommandMock.mockReset();
    pipelineMock.mockReset();
    configurePackMock.mockReset();
  });

  afterEach(async () => {
    await tempHome.restore();
  });

  it("does not leave a partial final archive behind when tar creation fails", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-failure-"));
    try {
      await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
      await fs.writeFile(path.join(stateDir, "state.txt"), "state\n", "utf8");

      tarCreateMock.mockRejectedValueOnce(new Error("disk full"));

      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };
      const outputPath = path.join(archiveDir, "backup.tar.gz");

      await expect(
        backupCreateCommand(runtime, {
          output: outputPath,
        }),
      ).rejects.toThrow(/disk full/i);

      await expect(fs.access(outputPath)).rejects.toThrow();
      const remaining = await fs.readdir(archiveDir);
      expect(remaining).toEqual([]);
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("does not overwrite an archive created after readiness checks complete", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-race-"));
    const realLink = fs.link.bind(fs);
    const linkSpy = vi.spyOn(fs, "link");
    try {
      await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
      await fs.writeFile(path.join(stateDir, "state.txt"), "state\n", "utf8");

      tarCreateMock.mockImplementationOnce(async ({ file }: { file: string }) => {
        await fs.writeFile(file, "archive-bytes", "utf8");
      });
      linkSpy.mockImplementationOnce(async (existingPath, newPath) => {
        await fs.writeFile(newPath, "concurrent-archive", "utf8");
        return await realLink(existingPath, newPath);
      });

      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };
      const outputPath = path.join(archiveDir, "backup.tar.gz");

      await expect(
        backupCreateCommand(runtime, {
          output: outputPath,
        }),
      ).rejects.toThrow(/refusing to overwrite existing backup archive/i);

      expect(await fs.readFile(outputPath, "utf8")).toBe("concurrent-archive");
    } finally {
      linkSpy.mockRestore();
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("falls back to exclusive copy when hard-link publication is unsupported", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-copy-fallback-"));
    const linkSpy = vi.spyOn(fs, "link");
    try {
      await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
      await fs.writeFile(path.join(stateDir, "state.txt"), "state\n", "utf8");

      tarCreateMock.mockImplementationOnce(async ({ file }: { file: string }) => {
        await fs.writeFile(file, "archive-bytes", "utf8");
      });
      linkSpy.mockRejectedValueOnce(
        Object.assign(new Error("hard links not supported"), { code: "EOPNOTSUPP" }),
      );

      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };
      const outputPath = path.join(archiveDir, "backup.tar.gz");

      const result = await backupCreateCommand(runtime, {
        output: outputPath,
      });

      expect(result.archivePath).toBe(outputPath);
      expect(await fs.readFile(outputPath, "utf8")).toBe("archive-bytes");
    } finally {
      linkSpy.mockRestore();
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("rejects immediately when the backup signal is already aborted", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-abort-"));
    try {
      await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
      await fs.writeFile(path.join(stateDir, "state.txt"), "state\n", "utf8");

      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };
      const abortController = new AbortController();
      abortController.abort("cron: job execution timed out");

      await expect(
        backupCreateCommand(runtime, {
          output: path.join(archiveDir, "backup.tar.gz"),
          signal: abortController.signal,
        }),
      ).rejects.toMatchObject({
        name: "AbortError",
        message: "cron: job execution timed out",
      });

      expect(tarCreateMock).not.toHaveBeenCalled();
      expect(packInstances).toHaveLength(0);
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("destroys the in-flight tar pack when aborted during archive creation", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-abort-midrun-"));
    try {
      await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
      await fs.writeFile(path.join(stateDir, "state.txt"), "state\n", "utf8");

      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };
      const abortController = new AbortController();
      const backupPromise = backupCreateCommand(runtime, {
        output: path.join(archiveDir, "backup.tar.gz"),
        signal: abortController.signal,
      });

      await vi.waitFor(() => {
        expect(packInstances).toHaveLength(1);
      });
      abortController.abort("cron: job execution timed out");

      await expect(backupPromise).rejects.toMatchObject({
        name: "AbortError",
        message: "cron: job execution timed out",
      });

      expect(packInstances[0]?.destroy).toHaveBeenCalled();
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("aborts fallback publish copy when backup signal is cancelled", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-abort-publish-"));
    const linkSpy = vi.spyOn(fs, "link");
    try {
      await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
      await fs.writeFile(path.join(stateDir, "state.txt"), "state\n", "utf8");

      tarCreateMock.mockImplementationOnce(async ({ file }: { file: string }) => {
        await fs.writeFile(file, "archive-bytes", "utf8");
      });
      linkSpy.mockRejectedValueOnce(
        Object.assign(new Error("hard links not supported"), { code: "EOPNOTSUPP" }),
      );
      configurePackMock.mockImplementationOnce((pack) => {
        let destination: NodeJS.WritableStream | undefined;
        pack.pipe.mockImplementation((dest) => {
          destination = dest;
          return dest;
        });
        pack.end.mockImplementation(() => {
          queueMicrotask(() => {
            (destination as { end?: () => void } | undefined)?.end?.();
          });
          return pack;
        });
      });
      pipelineMock.mockImplementationOnce(async (...args: unknown[]) => {
        const options = args[args.length - 1] as { signal?: AbortSignal } | undefined;
        const signal = options?.signal;
        await new Promise<void>((_resolve, reject) => {
          if (!signal) {
            reject(new Error("missing abort signal"));
            return;
          }
          if (signal.aborted) {
            reject(
              Object.assign(new Error(String(signal.reason ?? "Aborted")), { name: "AbortError" }),
            );
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              reject(
                Object.assign(new Error(String(signal.reason ?? "Aborted")), {
                  name: "AbortError",
                }),
              );
            },
            { once: true },
          );
        });
      });

      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };
      const abortController = new AbortController();
      const outputPath = path.join(archiveDir, "backup.tar.gz");
      const backupPromise = backupCreateCommand(runtime, {
        output: outputPath,
        signal: abortController.signal,
      });

      await vi.waitFor(() => {
        expect(pipelineMock).toHaveBeenCalledOnce();
      });
      abortController.abort("cron: job execution timed out");

      await expect(backupPromise).rejects.toMatchObject({
        name: "AbortError",
        message: "cron: job execution timed out",
      });
      await expect(fs.access(outputPath)).rejects.toThrow();
      expect(await fs.readdir(archiveDir)).toEqual([]);
    } finally {
      linkSpy.mockRestore();
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });
});
