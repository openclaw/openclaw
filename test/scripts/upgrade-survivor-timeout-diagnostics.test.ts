import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureUpdateProcesses,
  formatUpdateTimeoutDiagnostics,
} from "../../scripts/e2e/lib/upgrade-survivor/update-timeout-observation.mjs";

const proc = vi.hoisted(() => ({
  files: new Map<string, string>(),
  directories: new Map<string, string[]>(),
  links: new Map<string, string>(),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    open: async (file: string) => {
      const value = proc.files.get(file);
      if (value === undefined) {
        throw new Error("unreadable proc entry");
      }
      return {
        read: async (buffer: Buffer) => ({ bytesRead: buffer.write(value) }),
        close: async () => {},
      };
    },
    readdir: async (directory: string) => proc.directories.get(directory) ?? [],
    readlink: async (file: string) => {
      const value = proc.links.get(file);
      if (value === undefined) {
        throw new Error("closed descriptor");
      }
      return value;
    },
  },
}));

function processFixture(pid: number, parent: number, started = "123") {
  const root = `/proc/${pid}`;
  proc.files.set(
    `${root}/stat`,
    `${pid} (private process title) S ${parent} ${"0 ".repeat(17)}${started}`,
  );
  proc.files.set(
    `${root}/cmdline`,
    "node\0/private/update-candidate-state.worker.js\0--token\0private-value",
  );
  proc.files.set(`${root}/io`, "wchar: 4096\n");
  proc.files.set(`${root}/task/${pid}/children`, "");
  threadFixture(pid, pid);
  proc.directories.set(`${root}/task`, [String(pid)]);
  proc.directories.set(`${root}/fd`, ["18"]);
  proc.links.set(`${root}/fd/18`, "/private/openclaw-update-canary-a/.plugin-copy-b/payload");
  proc.files.set(`${root}/fdinfo/18`, "pos: 4096\nino: 99\nmnt_id: 7\n");
}

function threadFixture(pid: number, tid: number) {
  proc.files.set(`/proc/${pid}/task/${tid}/wchan`, "wait_log_commit\n");
  proc.files.set(
    `/proc/${pid}/task/${tid}/syscall`,
    `${process.arch === "arm64" ? 82 : 74} 0x12 0x0\n`,
  );
}

beforeEach(() => {
  proc.files.clear();
  proc.directories.clear();
  proc.links.clear();
});
afterEach(() => vi.restoreAllMocks());

describe("published update interruption diagnostics", () => {
  it("preserves the child output and exit status when a diagnostic read never settles", () => {
    const preload = `
      import fs from 'node:fs/promises';
      import { MessageChannel } from 'node:worker_threads';
      const original = fs.open;
      fs.open = function(file, ...args) {
        if (String(file).startsWith('/proc/')) {
          const { port1, port2 } = new MessageChannel();
          port1.on('message', () => port2.close());
          return new Promise(() => {});
        }
        return original.call(this, file, ...args);
      };
    `;
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        `data:text/javascript,${encodeURIComponent(preload)}`,
        fileURLToPath(
          new URL(
            "../../scripts/e2e/lib/upgrade-survivor/update-timeout-diagnostics.mjs",
            import.meta.url,
          ),
        ),
        "--",
        process.execPath,
        "-e",
        "console.log(JSON.stringify({ ok: true })); process.exitCode = 37;",
      ],
      { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(37);
    expect(result.stdout).toBe('{"ok":true}\n');
    expect(result.stderr).toBe("");
  });

  it("observes owned descendants and readable sync waits without exposing arguments or paths", async () => {
    processFixture(10, 1);
    proc.files.set("/proc/10/cmdline", "openclaw-update\0--token\0private-value");
    proc.files.set("/proc/10/task/10/children", "11 12");
    processFixture(11, 10);
    processFixture(12, 999);
    const sample = await captureUpdateProcesses(10);
    expect(sample.processes.map((entry) => entry.pid)).toEqual([10, 11]);
    const output = formatUpdateTimeoutDiagnostics([sample], sample.at);
    expect(output).toContain("pid=11 ppid=10 role=snapshot-worker");
    expect(output).toContain("wait=wait_log_commit");
    expect(output).toContain("plugin snapshot copy fsync-bound; progress unknown");
    expect(JSON.stringify(sample) + output).not.toMatch(/private|--token/u);
  });

  it.each([
    {
      change: "bytes",
      expected: [
        "Copy observation over 5.0s ",
        "same-file position bytes=+4096",
        "progress continuing",
      ],
    },
    {
      change: "files",
      expected: [
        "Copy observation over 5.0s ",
        "sampled new file handles=1",
        "progress continuing",
      ],
    },
    { change: "stationary", expected: ["progress stalled"] },
    { change: "reused-pid", expected: ["progress unknown"] },
    {
      change: "directory-idle",
      expected: ["worker write bytes=+0", "plugin snapshot copy fsync-bound; progress unknown"],
    },
    {
      change: "directory-writes",
      expected: ["worker write bytes=+4096", "plugin snapshot copy fsync-bound; progress unknown"],
    },
    ...["recovered-all", "recovered-partial"].map((change) => ({
      change,
      expected: ["worker write bytes=+0", "progress unknown", "File progress unavailable"],
    })),
    ...["incomplete-final", "truncated"].map((change) => ({
      change,
      expected: ["progress unknown"],
    })),
  ])(
    "reports copy progress only from comparable observations: $change",
    async ({ change, expected }) => {
      processFixture(10, 1);
      const descriptor = (fd: string, inode: number, position = 4096) => {
        proc.links.set(
          `/proc/10/fd/${fd}`,
          "/private/openclaw-update-canary-a/.plugin-copy-b/.fs-safe-second.tmp",
        );
        proc.files.set(`/proc/10/fdinfo/${fd}`, `pos: ${position}\nino: ${inode}\nmnt_id: 7\n`);
      };
      if (["stationary", "recovered-partial", "incomplete-final"].includes(change)) {
        proc.directories.set("/proc/10/fd", ["18", "19"]);
        descriptor("19", change === "stationary" ? 99 : 100, change === "stationary" ? 0 : 4096);
      }
      if (change.startsWith("directory-")) {
        proc.links.set("/proc/10/fd/18", "/private/openclaw-update-canary-a/.plugin-copy-b");
      }
      const recovered = change === "recovered-partial" ? "19" : "18";
      if (change.startsWith("recovered-")) {
        proc.files.delete(`/proc/10/fdinfo/${recovered}`);
      }
      const descriptors = Array.from({ length: 65 }, (_, index) => String(index + 18));
      if (change === "truncated") {
        proc.directories.set("/proc/10/fd", descriptors);
        for (const fd of descriptors.slice(1)) {
          proc.links.set(`/proc/10/fd/${fd}`, "pipe:[123]");
        }
        descriptor("82", 100);
      }
      vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(6_000);
      const first = await captureUpdateProcesses(10);
      if (change === "reused-pid") {
        processFixture(10, 1, "456");
      }
      if (["bytes", "files", "reused-pid"].includes(change)) {
        descriptor("18", change === "bytes" ? 99 : 100, change === "files" ? 4096 : 8192);
      }
      if (["bytes", "files", "directory-writes"].includes(change)) {
        proc.files.set("/proc/10/io", "wchar: 8192\n");
      }
      if (change.startsWith("recovered-")) {
        descriptor(recovered, recovered === "19" ? 100 : 99);
      }
      if (change === "incomplete-final") {
        proc.files.delete("/proc/10/fdinfo/19");
      }
      if (change === "truncated") {
        proc.directories.set(
          "/proc/10/fd",
          descriptors.filter((fd) => fd !== "19"),
        );
      }
      const last = await captureUpdateProcesses(10);
      const output = formatUpdateTimeoutDiagnostics([first, last], 6_000);
      for (const text of expected) {
        expect(output).toContain(text);
      }
      if (change === "stationary") {
        proc.files.delete("/proc/10/io");
        const unreadable = await captureUpdateProcesses(10);
        expect(formatUpdateTimeoutDiagnostics([first, unreadable])).toContain("progress unknown");
      }
    },
  );

  it("bounds large process trees and emitted thread diagnostics", async () => {
    processFixture(10, 1);
    const children = Array.from({ length: 40 }, (_, index) => index + 20);
    proc.files.set("/proc/10/task/10/children", children.join(" "));
    for (const pid of children) {
      processFixture(pid, 10);
      const threads = Array.from({ length: 20 }, (_, index) => 1000 + index);
      proc.directories.set(`/proc/${pid}/task`, threads.map(String));
      for (const tid of threads) {
        threadFixture(pid, tid);
      }
    }
    vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(6_000);
    const first = await captureUpdateProcesses(10);
    const sample = await captureUpdateProcesses(10);
    expect(sample.processes).toHaveLength(32);
    expect(sample.truncated).toBe(true);
    expect(sample.processes[1]?.waits).toHaveLength(16);
    const output = formatUpdateTimeoutDiagnostics([first, sample], 6_000);
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(12_000);
    expect(output).toContain("Diagnostic output truncated.");
    const consoleTail = output.trimEnd().split("\n").slice(-120).join("\n");
    expect(consoleTail).toContain("Last sample 0.0s ago");
    expect(consoleTail).toContain("Copy observation over 5.0s");
    expect(consoleTail).toContain(
      "published-driver plugin snapshot copy fsync-bound; progress stalled",
    );
  });

  it("keeps inaccessible process evidence explicitly unavailable", async () => {
    const sample = await captureUpdateProcesses(10);
    expect(formatUpdateTimeoutDiagnostics([sample])).toContain(
      "process observation unavailable; progress unknown",
    );
  });
});
