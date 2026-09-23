import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { parseRemoteWorkspaceManifestEnvelope } from "./workspace-hash-memo.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "./workspace-sync-scripts.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function manifestWorkspace() {
  const root = await fs.realpath(tempDirs.make("openclaw-manifest-hashing-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  await Promise.all([fs.mkdir(home), fs.mkdir(workspace)]);
  return { root, home, workspace };
}

it("hashes concurrently within four readers and preserves manifest and memo ordering", async () => {
  const { root, home, workspace } = await manifestWorkspace();
  const auditPath = path.join(root, "handles.json");
  const entries = await Promise.all(
    Array.from({ length: 8 }, async (_, index) => {
      const name = `${index}.bin`;
      const content = Buffer.alloc(1024, index);
      const file = path.join(workspace, name);
      await fs.writeFile(file, content, { mode: 0o600 });
      return {
        path: name,
        type: "file",
        mode: 0o644,
        size: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
      };
    }),
  );
  const prelude = String.raw`{
    const io = require("node:fs");
    const open = io.promises.open.bind(io.promises);
    const handles = [];
    let active = 0, maximum = 0, activeAtResult;
    io.promises.open = async (...args) => {
      active++;
      maximum = Math.max(maximum, active);
      const handle = await open(...args);
      handles.push(handle);
      const close = handle.close.bind(handle);
      let closed = false;
      handle.close = async () => {
        await close();
        if (!closed) { closed = true; active--; }
      };
      return handle;
    };
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (...args) => { activeAtResult = active; return write(...args); };
    process.once("exit", () => io.writeFileSync(${JSON.stringify(auditPath)}, JSON.stringify({
      maximum, activeAtResult, closed: handles.map((handle) => handle.fd === -1),
    })));
  }
  `;
  let memo: Array<[string, string]> = [];
  let manifestRef: string | undefined;
  for (const cached of [false, true]) {
    const result = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        prelude + REMOTE_WORKSPACE_MANIFEST_JS,
        workspace,
        "",
        "all",
        "memo-v1",
      ],
      { timeoutMs: 10_000, baseEnv: { ...process.env, HOME: home }, input: JSON.stringify(memo) },
    );
    expect(result).toMatchObject({ code: 0, stderr: "" });
    const response = parseRemoteWorkspaceManifestEnvelope(result.stdout);
    expect(response.metrics).toMatchObject({
      contentHashCount: cached ? 0 : entries.length,
      memoHitCount: cached ? entries.length : 0,
      memoTruncatedCount: 0,
    });
    const raw = await fs.readFile(
      path.join(home, ".openclaw-worker", "manifests", `${response.manifestRef.slice(7)}.json`),
      "utf8",
    );
    expect(JSON.parse(raw)).toEqual({ version: 1, baseCommit: null, entries });
    expect(response.manifestRef).toBe(`sha256:${createHash("sha256").update(raw).digest("hex")}`);
    if (cached) {
      expect(response.manifestRef).toBe(manifestRef);
      expect(response.memo).toEqual(memo);
    }
    memo = response.memo;
    manifestRef = response.manifestRef;
    const audit = JSON.parse(await fs.readFile(auditPath, "utf8")) as { maximum: number };
    expect(audit).toMatchObject({ activeAtResult: 0, closed: Array(entries.length).fill(true) });
    expect(audit.maximum).toBeGreaterThan(1);
    expect(audit.maximum).toBeLessThanOrEqual(4);
  }
});

it.each(["pending-open", "active-reader"] as const)(
  "preserves the first failure and joins a %s before reporting it",
  async (mode) => {
    const { root, home, workspace } = await manifestWorkspace();
    const first = path.join(workspace, "a.bin");
    const second = path.join(workspace, "b.bin");
    const auditPath = path.join(root, "failure.json");
    await Promise.all([fs.writeFile(first, "first"), fs.writeFile(second, Buffer.alloc(64))]);
    // Real opens and streams are held at their I/O boundaries, without a timing race.
    const prelude = String.raw`{
      const io = require("node:fs");
      const first = ${JSON.stringify(first)}, second = ${JSON.stringify(second)};
      const mode = ${JSON.stringify(mode)};
      const handles = [], started = new Set();
      let releaseOpen, releaseRead;
      const openGate = new Promise((resolve) => { releaseOpen = resolve; });
      const readGate = new Promise((resolve) => { releaseRead = resolve; });
      let pending = 0, readStarted = false, secondStats = 0, atFailure;
      let reading;
      const open = io.promises.open.bind(io.promises);
      io.promises.open = async (...args) => {
        const file = args[0];
        started.add(file);
        pending++;
        if (file === second && mode === "pending-open") await openGate;
        const handle = await open(...args);
        pending--;
        handles.push(handle);
        const stat = handle.stat.bind(handle), close = handle.close.bind(handle);
        handle.stat = async (...options) => {
          if (file === first) {
            if (mode === "active-reader" && started.has(second)) await readGate;
            throw new Error("first manifest failure");
          }
          secondStats++;
          return stat(...options);
        };
        handle.close = async () => {
          await close();
          if (file === first) {
            await new Promise((resolve) => setImmediate(resolve));
            releaseOpen();
            throw new Error("secondary close failure");
          }
        };
        if (file === second && mode === "active-reader") {
          const createReadStream = handle.createReadStream.bind(handle);
          handle.createReadStream = (options) => {
            const stream = createReadStream({ ...options, highWaterMark: 2 });
            reading = stream;
            const iterate = stream[Symbol.asyncIterator].bind(stream);
            const aborted = new Promise((resolve) => {
              if (options.signal?.aborted) resolve();
              else options.signal?.addEventListener("abort", resolve, { once: true });
            });
            stream[Symbol.asyncIterator] = async function* () {
              for await (const chunk of iterate()) {
                readStarted = true;
                releaseRead();
                await aborted;
                yield chunk;
              }
            };
            return stream;
          };
        }
        return handle;
      };
      const write = process.stderr.write.bind(process.stderr);
      process.stderr.write = (...args) => {
        atFailure = { pending, closed: handles.every((handle) => handle.fd === -1) };
        return write(...args);
      };
      process.once("exit", () => io.writeFileSync(${JSON.stringify(auditPath)}, JSON.stringify({
        atFailure, opened: handles.length, pending, readStarted, secondStats,
        streamDestroyed: reading?.destroyed, closed: handles.every((handle) => handle.fd === -1),
      })));
    }
    `;
    const result = await runCommandWithTimeout(
      [process.execPath, "-e", prelude + REMOTE_WORKSPACE_MANIFEST_JS, workspace],
      { timeoutMs: 10_000, baseEnv: { ...process.env, HOME: home } },
    );
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("first manifest failure");
    expect(result.stderr).not.toContain("secondary close failure");
    const audit = JSON.parse(await fs.readFile(auditPath, "utf8"));
    expect(audit).toMatchObject({
      opened: 2,
      pending: 0,
      closed: true,
      readStarted: mode === "active-reader",
      atFailure: { pending: 0, closed: true },
    });
    expect(audit).toMatchObject(
      mode === "pending-open" ? { secondStats: 0 } : { streamDestroyed: true },
    );
    expect(await fs.readdir(path.join(home, ".openclaw-worker", "manifests"))).toEqual([]);
  },
);
