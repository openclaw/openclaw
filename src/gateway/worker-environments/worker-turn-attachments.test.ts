import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveMediaBuffer } from "../../media/store.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import type { WorkerWorkspaceCommand } from "./tunnel-contract.js";
import { prepareWorkerTurnAttachments } from "./worker-turn-attachments.js";

describe("cloud attachment transfer confinement", () => {
  let root: string, remote: string, originalPath: string, bytes: Buffer;
  beforeEach(async () => {
    bytes = Buffer.from("%PDF-1.7\nreal original bytes");
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cloud-attachments-")));
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    remote = path.join(await fs.realpath(root), "remote");
    await fs.mkdir(remote);
    originalPath = (
      await saveMediaBuffer(bytes, "application/pdf", "inbound", bytes.length, "report.pdf")
    ).path;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  const execute = (command: WorkerWorkspaceCommand) =>
    runCommandWithTimeout([...command.argv], {
      cwd: remote,
      input: command.input,
      timeoutMs: 10_000,
      signal: command.signal,
    });
  const prepare = (
    runWorkspaceCommand = execute,
    media: NonNullable<Parameters<typeof prepareWorkerTurnAttachments>[0]["turn"]["media"]> = [
      { path: originalPath, contentType: "application/pdf" },
    ],
    assertCurrent = () => {},
  ) =>
    prepareWorkerTurnAttachments({
      turn: { timeoutMs: 5_000, media },
      remoteWorkspaceDir: remote,
      tunnel: { runWorkspaceCommand },
      assertCurrent,
    });

  it("removes incomplete files after a checksum failure without changing other workspace files", async () => {
    await fs.writeFile(path.join(remote, "keep.txt"), "remote edits");
    const runWorkspaceCommand = vi.fn(async (command: WorkerWorkspaceCommand) =>
      execute(
        command.input === undefined
          ? command
          : { ...command, input: Buffer.from("%PDF-1.7\ncorrupt bytes here!").toString("base64") },
      ),
    );
    await expect(prepare(runWorkspaceCommand)).rejects.toThrow(/checksum|invalid attachment chunk/);
    expect(await fs.readdir(remote)).toEqual(["keep.txt"]);
    expect(await fs.readFile(path.join(remote, "keep.txt"), "utf8")).toBe("remote edits");
  });

  it("rejects a replaced upload directory without following its symlink during write or cleanup", async () => {
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "keep.txt"), "outside");
    let initialized = false;
    const runWorkspaceCommand = vi.fn(async (command: WorkerWorkspaceCommand) => {
      const result = await execute(command);
      if (!initialized) {
        initialized = true;
        const [directory] = await fs.readdir(remote);
        await fs.rename(path.join(remote, directory!), path.join(root, "original-upload"));
        await fs.symlink(outside, path.join(remote, directory!), "dir");
      }
      return result;
    });
    await expect(prepare(runWorkspaceCommand)).rejects.toThrow("attachment directory changed");
    expect(await fs.readdir(outside)).toEqual(["keep.txt"]);
    expect(await fs.readFile(path.join(outside, "keep.txt"), "utf8")).toBe("outside");
  });

  it("stops after claim loss and never uses a stale claim for cleanup", async () => {
    let current = true;
    const runWorkspaceCommand = vi.fn(async (command: WorkerWorkspaceCommand) => {
      const result = await execute(command);
      current = false;
      return result;
    });
    await expect(
      prepare(runWorkspaceCommand, undefined, () => {
        if (!current) {
          throw new Error("lost claim");
        }
      }),
    ).rejects.toThrow("lost claim");
    expect(runWorkspaceCommand).toHaveBeenCalledOnce();
    const [directory] = await fs.readdir(remote);
    expect(await fs.readdir(path.join(remote, directory!))).toEqual([]);
  });

  it.each(["path", "url"] as const)("rejects unmanaged %s", async (field) => {
    const privatePath = path.join(root, "private.txt");
    await fs.writeFile(privatePath, "not an admitted attachment");
    const runWorkspaceCommand = vi.fn();
    await expect(prepare(runWorkspaceCommand, [{ [field]: privatePath }])).rejects.toThrow(
      "attach the file again",
    );
    expect(runWorkspaceCommand).not.toHaveBeenCalled();
  });

  it("stages the managed original URL with a monotonic integer transfer budget", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(500).mockReturnValue(500.25);
    vi.spyOn(Date, "now").mockReturnValueOnce(500).mockReturnValue(-89_500);
    const runWorkspaceCommand = vi.fn(execute);
    const note = await prepare(runWorkspaceCommand, [
      {
        path: path.join(root, "gateway-copy.pdf"),
        url: originalPath,
        fileName: "original.pdf",
      },
    ]);
    const [directory] = await fs.readdir(remote);
    expect(note).toContain(directory);
    expect(await fs.readFile(path.join(remote, directory!, "1-original.pdf"))).toEqual(bytes);
    // Integral budget: the node protocol rejects fractional timeoutMs.
    expect(runWorkspaceCommand.mock.calls.map(([command]) => command.timeoutMs)).toEqual([
      4999, 4999,
    ]);
  });
});
