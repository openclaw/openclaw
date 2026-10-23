import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { afterEach, aroundEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { withChannelReadAuthority } from "../shared/channel-read-authority.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { saveRemoteMedia } from "./fetch.js";
import { mediaNativeProcessEntrypoints } from "./native-process-runtime.test-support.js";
import { saveMediaBuffer, saveMediaSource, saveMediaStream } from "./store.js";
import { unlinkIfExists } from "./temp-files.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const bytes = Buffer.from("%PDF-1.4\n%%EOF\n");
const pdf = "application/pdf";
const inboundPdfArgs = [pdf, "inbound", undefined, undefined, undefined] as const;
const execFileAsync = promisify(execFile);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function* mediaBytes() {
  yield bytes;
}
function withRead<T>(run: () => Promise<T>) {
  return withChannelReadAuthority(() => {}, run);
}
function revocableRead(message = "Session media authority changed") {
  let active = true;
  const revoked = new Error(message);
  const assertCurrent = () => {
    if (!active) {
      throw revoked;
    }
  };
  return {
    revoked,
    assertCurrent,
    revoke: () => {
      active = false;
    },
    run: <T>(operation: () => Promise<T>) => withChannelReadAuthority(assertCurrent, operation),
  };
}
async function mediaFixture(state: OpenClawTestState, subdir: string, prepare: boolean) {
  const dir = state.statePath("media", subdir);
  if (prepare) {
    await fs.mkdir(dir, { recursive: true });
  }
  return {
    dir,
    realDir: prepare ? await fs.realpath(dir) : dir,
    source: () => state.writeText("source.pdf", bytes.toString()),
    entries: () => fs.readdir(dir),
    buffer: () => saveMediaBuffer(bytes, pdf, subdir),
    stream: (input: AsyncIterable<unknown> = mediaBytes()) => saveMediaStream(input, pdf, subdir),
    saveSource: (source: string) => saveMediaSource(source, undefined, subdir),
  };
}
function observeOpen(
  visit: (handle: FileHandle, file: string, flags?: string | number) => void | Promise<void>,
) {
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (typeof args[0] === "string") {
      await visit(handle, args[0], args[1]);
    }
    return handle;
  });
}

describe("read-owned media publication", () => {
  let state: OpenClawTestState;
  aroundEach((runTest) =>
    withOpenClawTestState({ layout: "state-only" }, async (current) => {
      state = current;
      await runTest();
    }),
  );
  it.each(["buffer", "stream"] as const)(
    "checks client authority after writing %s",
    async (kind: "buffer" | "stream") => {
      const f = await mediaFixture(state, "inbound", true);

      let wrote = false;
      const client = revocableRead("client upload policy changed");
      observeOpen((handle, file, flags) => {
        if (path.dirname(file) === f.realDir && flags === "wx") {
          const write = handle.writeFile.bind(handle);
          vi.spyOn(handle, "writeFile").mockImplementation(async (...args) => {
            await write(...args);
            wrote = true;
            client.revoke();
          });
        }
      });
      const options = { assertCommitAllowed: client.assertCurrent };
      await expect(
        withRead(() =>
          kind === "buffer"
            ? saveMediaBuffer(bytes, ...inboundPdfArgs, options)
            : saveMediaStream(mediaBytes(), ...inboundPdfArgs, options),
        ),
      ).rejects.toBe(client.revoked);
      expect(wrote).toBe(true);
      expect(await f.entries()).toEqual([]);
    },
  );

  it("rejects source publication when file sync fails", async () => {
    const f = await mediaFixture(state, "outbound", true);

    const source = await f.source();
    const error = Object.assign(new Error("synthetic media sync failure"), { code: "EIO" });
    observeOpen((handle, file, flags) => {
      if (path.dirname(file) === f.realDir && flags === "wx") {
        vi.spyOn(handle, "sync").mockRejectedValue(error);
      }
    });
    await expect(withRead(() => f.saveSource(source))).rejects.toBe(error);
    expect(await f.entries()).toEqual([]);
    expect(await fs.readFile(source)).toEqual(bytes);
  });

  it.skipIf(process.platform === "win32").each([
    ["buffer", false],
    ["source", true],
  ] as const)(
    "syncs %s before publication and its parent afterward (directory fails=%s)",
    async (kind: "buffer" | "source", failDirectorySync: boolean) => {
      const f = await mediaFixture(state, "outbound", true);

      const source = await f.source();
      const events: string[] = [];
      observeOpen((handle, file, flags) => {
        const sync = handle.sync.bind(handle);
        if (path.dirname(file) === f.realDir && flags === "wx") {
          vi.spyOn(handle, "sync").mockImplementation(async () => {
            expect((await f.entries()).every((name) => name.endsWith(".tmp"))).toBe(true);
            await sync();
            events.push("file");
          });
        } else if (file === f.realDir) {
          vi.spyOn(handle, "sync").mockImplementation(async () => {
            expect(events).toEqual(["file"]);
            expect(await f.entries()).toEqual([expect.stringMatching(/\.pdf$/)]);
            if (failDirectorySync) {
              events.push("directory");
              throw Object.assign(new Error("synthetic directory sync failure"), { code: "EIO" });
            }
            await sync();
            events.push("directory");
          });
        }
      });
      const saved = await withRead(() => (kind === "buffer" ? f.buffer() : f.saveSource(source)));
      expect(events).toEqual(["file", "directory"]);
      expect(await fs.readFile(saved.path)).toEqual(bytes);
      expect(await f.entries()).toEqual([saved.id]);
    },
  );

  it.skipIf(process.platform === "win32").each(["file", "directory"] as const)(
    "discards media revoked during %s sync",
    async (phase: "file" | "directory") => {
      const f = await mediaFixture(state, "outbound", true);

      const syncing = createDeferred();
      const release = createDeferred();
      const authority = revocableRead();
      observeOpen((handle, file, flags) => {
        const matches =
          phase === "file"
            ? path.dirname(file) === f.realDir && flags === "wx"
            : file === f.realDir;
        if (matches) {
          const sync = handle.sync.bind(handle);
          vi.spyOn(handle, "sync").mockImplementation(async () => {
            await sync();
            syncing.resolve();
            await release.promise;
          });
        }
      });
      const rejected = expect(authority.run(f.buffer)).rejects.toBe(authority.revoked);
      try {
        await syncing.promise;
        authority.revoke();
      } finally {
        release.resolve();
      }
      await rejected;
      expect(await f.entries()).toEqual([]);
    },
  );

  it("does not read bytes after revocation during source opening", async () => {
    const f = await mediaFixture(state, "outbound", false);

    const source = await f.source();
    const opened = createDeferred();
    const resume = createDeferred();
    const authority = revocableRead();
    let reads = 0;
    observeOpen(async (handle, file) => {
      if (file === source) {
        const read = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementation((...args) => {
          reads += 1;
          return read(...args);
        });
        opened.resolve();
        await resume.promise;
      }
    });
    const rejected = expect(authority.run(() => f.saveSource(source))).rejects.toBe(
      authority.revoked,
    );
    await opened.promise;
    authority.revoke();
    resume.resolve();
    await rejected;
    expect(reads).toBe(0);
  });

  it("removes only new output when the host rejects its completed read", async () => {
    const f = await mediaFixture(state, "outbound", true);

    const source = await f.source();
    const preserved = path.join(f.dir, "existing.pdf");
    await fs.writeFile(preserved, bytes);
    const authority = revocableRead();
    await expect(
      authority.run(async () => {
        const saved = await f.saveSource(source);
        expect(await fs.readFile(saved.path)).toEqual(bytes);
        authority.revoke();
      }),
    ).rejects.toBe(authority.revoked);
    expect(await f.entries()).toEqual(["existing.pdf"]);
    expect(await fs.readFile(preserved)).toEqual(bytes);
  });

  it.skipIf(process.platform === "win32").each([0o600, 0o644])(
    "rejects unreadable files when chmod fails (mode=%i)",
    async (mode: number) => {
      const f = await mediaFixture(state, "inbound", false);

      const error = Object.assign(new Error("synthetic mode finalization failure"), {
        code: "EPERM",
      });
      observeOpen(async (handle, file, flags) => {
        if (file.startsWith(`${f.dir}${path.sep}`) && flags === "wx") {
          await handle.chmod(mode);
          vi.spyOn(handle, "chmod").mockRejectedValue(error);
        }
      });
      const operation = withRead(() => f.stream());
      if (mode === 0o600) {
        await expect(operation).rejects.toBe(error);
        expect(await f.entries()).toEqual([]);
      } else {
        expect(await fs.readFile((await operation).path)).toEqual(bytes);
      }
    },
  );

  it.each([false, true])(
    "cleans only owned staging on process exit (replacement=%s)",
    async (replace: boolean) => {
      const f = await mediaFixture(state, "inbound", false);

      const mediaDir = f.dir;
      const displaced = state.statePath("user-owned.pdf");
      const storeUrl = resolveRuntimeWorkerUrl(mediaNativeProcessEntrypoints.store);
      const authorityUrl = resolveRuntimeWorkerUrl(
        mediaNativeProcessEntrypoints.channelReadAuthority,
      );
      const script = `
          import fs from 'node:fs';
          import path from 'node:path';
          import { withChannelReadAuthority } from ${JSON.stringify(authorityUrl.href)};
          import { saveMediaStream } from ${JSON.stringify(storeUrl.href)};
          const mediaDir = ${JSON.stringify(mediaDir)};
          const stream = (async function* () {
            yield Buffer.from(${JSON.stringify(bytes.toString())});
            const name = fs.readdirSync(mediaDir).find((entry) => entry.endsWith('.tmp'));
            if (!name) throw new Error('No active media stage');
            const stage = path.join(mediaDir, name);
            if (${replace}) {
              fs.renameSync(stage, ${JSON.stringify(displaced)});
              fs.writeFileSync(stage, 'replacement');
            }
            fs.writeSync(1, JSON.stringify({ stage }));
            process.exit(0);
          })();
          await withChannelReadAuthority(() => {}, () => saveMediaStream(stream, 'application/pdf'));
          process.exitCode = 2;
        `;

      const { stdout } = await execFileAsync(
        process.execPath,
        [...resolveRuntimeWorkerArgv(storeUrl).slice(0, -1), "--input-type=module", "-e", script],
        { cwd: process.cwd(), env: { ...process.env, ...state.envVars }, timeout: 20_000 },
      );
      const { stage } = JSON.parse(stdout) as { stage: string };
      if (replace) {
        expect(await fs.readFile(stage, "utf8")).toBe("replacement");
        expect(await fs.readFile(displaced)).toEqual(bytes);
      } else {
        expect(await f.entries()).toEqual([]);
      }
    },
  );

  it.each(["replacement", "shared"] as const)(
    "preserves rejected %s staging",
    async (kind: "replacement" | "shared") => {
      const f = await mediaFixture(state, "inbound", false);

      const displaced = state.statePath("user-owned.pdf");
      let staged: string | undefined;
      observeOpen((_handle, file, flags) => {
        if (file.startsWith(`${f.dir}${path.sep}`) && flags === "wx") {
          staged = file;
        }
      });
      const stream = (async function* () {
        yield bytes;
        if (!staged) {
          throw new Error("Expected the media store's exclusive staging write");
        }
        if (kind === "replacement") {
          await fs.rename(staged, displaced);
          await fs.writeFile(staged, "replacement");
        } else {
          await fs.link(staged, displaced);
        }
      })();
      await expect(withRead(() => f.stream(stream))).rejects.toThrow(/created file|hardlink|path/i);
      expect(staged).toBeDefined();
      expect(await fs.readFile(staged!)).toEqual(
        kind === "replacement" ? Buffer.from("replacement") : bytes,
      );
      expect(await fs.readFile(displaced)).toEqual(bytes);
    },
  );

  it("preserves replacements across repeated disposal", async () => {
    const f = await mediaFixture(state, "inbound", false);

    await withRead(async () => {
      const saved = await f.stream();
      const displaced = state.statePath("displaced.pdf");
      await fs.rename(saved.path, displaced);
      await fs.writeFile(saved.path, "replacement");
      await unlinkIfExists(saved.path);
      await unlinkIfExists(saved.path);
      expect(await fs.readFile(saved.path, "utf8")).toBe("replacement");
      expect(await fs.readFile(displaced)).toEqual(bytes);
    });
  });

  it("honors request timeout after response completion", async () => {
    const f = await mediaFixture(state, "inbound", true);

    const request = new AbortController();
    const timedOut = new Error("synthetic request timeout");
    let checks = 0;
    let sent = false;
    await withChannelReadAuthority(
      () => {
        checks += 1;
      },
      async () => {
        const response = new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!sent) {
                sent = true;
                controller.enqueue(bytes);
                return;
              }
              controller.close();
              request.abort(timedOut);
            },
          }),
          { headers: { "content-type": pdf } },
        );
        await expect(
          saveRemoteMedia({
            url: `https://media.example.test/${randomUUID()}.pdf`,
            requestInit: { signal: request.signal },
            lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
            fetchImpl: async () => response,
          }),
        ).rejects.toBe(timedOut);
        expect(await f.entries()).toEqual([]);
      },
    );
    expect(checks).toBeGreaterThan(0);
  });
});

it("rejects a changed parent alias without deleting its new destination", async () => {
  const workspace = tempDirs.make("read-media-alias-");
  const original = path.join(workspace, "original");
  const replacement = path.join(workspace, "replacement");
  const alias = path.join(workspace, "state");
  const originalMedia = path.join(original, "media", "inbound");
  const replacementMedia = path.join(replacement, "media", "inbound");
  await fs.mkdir(originalMedia, { recursive: true });
  await fs.mkdir(replacementMedia, { recursive: true });
  const preserved = path.join(replacementMedia, "existing.txt");
  await fs.writeFile(preserved, "existing user attachment");
  await fs.symlink(original, alias, process.platform === "win32" ? "junction" : "dir");
  vi.stubEnv("OPENCLAW_STATE_DIR", alias);
  const stream = (async function* () {
    yield bytes;
    await fs.unlink(alias);
    await fs.symlink(replacement, alias, process.platform === "win32" ? "junction" : "dir");
  })();
  await expect(withRead(() => saveMediaStream(stream, pdf))).rejects.toSatisfy(
    (error: unknown) => error instanceof FsSafeError && error.code === "path-mismatch",
  );
  expect(await fs.readdir(originalMedia)).toEqual([]);
  expect(await fs.readFile(preserved, "utf8")).toBe("existing user attachment");
  expect(await fs.readdir(replacementMedia)).toEqual(["existing.txt"]);
});
