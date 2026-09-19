import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withChannelReadAuthority } from "../shared/channel-read-authority.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { saveRemoteMedia } from "./fetch.js";
import { readLocalMediaFile } from "./local-media-access.js";
import { saveMediaBuffer, saveMediaSource, saveMediaStream } from "./store.js";
import { unlinkIfExists } from "./temp-files.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const bytes = Buffer.from("%PDF-1.4\n%%EOF\n");
const execFileAsync = promisify(execFile);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function* mediaBytes() {
  yield bytes;
}

describe("read-owned media publication", () => {
  it.each(["buffer", "source"] as const)(
    "rejects scoped %s publication when durable file sync fails",
    async (kind) => {
      await withOpenClawTestState({ layout: "state-only" }, async (state) => {
        const source = state.statePath("source.pdf");
        const mediaDir = state.statePath("media", "outbound");
        await fs.writeFile(source, bytes);
        await fs.mkdir(mediaDir, { recursive: true });
        const realMediaDir = await fs.realpath(mediaDir);
        const syncError = Object.assign(new Error("synthetic media sync failure"), { code: "EIO" });
        const open = fs.open.bind(fs);
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          const handle = await open(...args);
          if (
            typeof args[0] === "string" &&
            path.dirname(args[0]) === realMediaDir &&
            args[1] === "wx"
          ) {
            vi.spyOn(handle, "sync").mockRejectedValue(syncError);
          }
          return handle;
        });
        await expect(
          withChannelReadAuthority(
            () => {},
            () =>
              kind === "buffer"
                ? saveMediaBuffer(bytes, "application/pdf", "outbound")
                : saveMediaSource(source, undefined, "outbound"),
          ),
        ).rejects.toBe(syncError);
        expect(await fs.readdir(mediaDir)).toEqual([]);
        expect(await fs.readFile(source)).toEqual(bytes);
      });
    },
  );

  it.skipIf(process.platform === "win32").each([
    ["buffer", false],
    ["buffer", true],
    ["source", false],
    ["source", true],
  ] as const)(
    "syncs scoped %s content before publication and its parent afterward (directory fails=%s)",
    async (kind, failDirectorySync) => {
      await withOpenClawTestState({ layout: "state-only" }, async (state) => {
        const source = state.statePath("source.pdf");
        const mediaDir = state.statePath("media", "outbound");
        await fs.writeFile(source, bytes);
        await fs.mkdir(mediaDir, { recursive: true });
        const realMediaDir = await fs.realpath(mediaDir);
        const syncEvents: string[] = [];
        const open = fs.open.bind(fs);
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          const handle = await open(...args);
          if (typeof args[0] !== "string") {
            return handle;
          }
          const sync = handle.sync.bind(handle);
          if (path.dirname(args[0]) === realMediaDir && args[1] === "wx") {
            vi.spyOn(handle, "sync").mockImplementation(async () => {
              expect((await fs.readdir(mediaDir)).every((name) => name.endsWith(".tmp"))).toBe(
                true,
              );
              await sync();
              syncEvents.push("file");
            });
          } else if (args[0] === realMediaDir) {
            vi.spyOn(handle, "sync").mockImplementation(async () => {
              expect(syncEvents).toEqual(["file"]);
              const published = await fs.readdir(mediaDir);
              expect(published).toHaveLength(1);
              expect(published[0]).toMatch(/\.pdf$/);
              if (failDirectorySync) {
                syncEvents.push("directory");
                throw Object.assign(new Error("synthetic directory sync failure"), { code: "EIO" });
              }
              await sync();
              syncEvents.push("directory");
            });
          }
          return handle;
        });
        const saved = await withChannelReadAuthority(
          () => {},
          () =>
            kind === "buffer"
              ? saveMediaBuffer(bytes, "application/pdf", "outbound")
              : saveMediaSource(source, undefined, "outbound"),
        );
        expect(syncEvents).toEqual(["file", "directory"]);
        expect(await fs.readFile(saved.path)).toEqual(bytes);
        expect(await fs.readdir(mediaDir)).toEqual([saved.id]);
      });
    },
  );

  it.skipIf(process.platform === "win32").each(["file", "directory"] as const)(
    "discards scoped media when authority changes during %s sync",
    async (phase) => {
      await withOpenClawTestState({ layout: "state-only" }, async (state) => {
        const mediaDir = state.statePath("media", "outbound");
        await fs.mkdir(mediaDir, { recursive: true });
        const realMediaDir = await fs.realpath(mediaDir);
        const syncing = createDeferred();
        const release = createDeferred();
        let active = true;
        const revoked = new Error("Session media authority changed during sync");
        const open = fs.open.bind(fs);
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          const handle = await open(...args);
          const match =
            typeof args[0] === "string" &&
            (phase === "file"
              ? path.dirname(args[0]) === realMediaDir && args[1] === "wx"
              : args[0] === realMediaDir);
          if (match) {
            const sync = handle.sync.bind(handle);
            vi.spyOn(handle, "sync").mockImplementation(async () => {
              await sync();
              syncing.resolve();
              await release.promise;
            });
          }
          return handle;
        });
        const operation = withChannelReadAuthority(
          () => {
            if (!active) {
              throw revoked;
            }
          },
          () => saveMediaBuffer(bytes, "application/pdf", "outbound"),
        );
        const rejected = expect(operation).rejects.toBe(revoked);
        try {
          await syncing.promise;
          active = false;
        } finally {
          release.resolve();
        }
        await rejected;
        expect(await fs.readdir(mediaDir)).toEqual([]);
      });
    },
  );

  it.each(["local-reader", "source-store"] as const)(
    "does not read source bytes after authority changes during %s file opening",
    async (reader) => {
      await withOpenClawTestState({ layout: "state-only" }, async (state) => {
        const source = state.statePath("source.pdf");
        await fs.writeFile(source, bytes);
        const opened = createDeferred();
        const resume = createDeferred();
        const revoked = new Error("Session media authority changed");
        let active = true;
        let sourceReads = 0;
        const open = fs.open.bind(fs);
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          const handle = await open(...args);
          if (args[0] === source) {
            const read = handle.read.bind(handle);
            vi.spyOn(handle, "read").mockImplementation((...readArgs) => {
              sourceReads += 1;
              return read(...readArgs);
            });
            opened.resolve();
            await resume.promise;
          }
          return handle;
        });
        const operation = withChannelReadAuthority(
          () => {
            if (!active) {
              throw revoked;
            }
          },
          async () => {
            if (reader === "local-reader") {
              await readLocalMediaFile(source, [state.stateDir], { maxBytes: 1024 });
            } else {
              await saveMediaSource(source, undefined, "outbound");
            }
          },
        );
        const rejection = expect(operation).rejects.toBe(revoked);
        await opened.promise;
        active = false;
        resume.resolve();
        await rejection;
        expect(sourceReads).toBe(0);
      });
    },
  );

  it.each(["buffer", "source"] as const)(
    "removes %s output when the host rejects the completed read",
    async (kind) => {
      await withOpenClawTestState({ layout: "state-only" }, async (state) => {
        const source = state.statePath("source.pdf");
        const mediaDir = state.statePath("media", "outbound");
        await fs.writeFile(source, bytes);
        await fs.mkdir(mediaDir, { recursive: true });
        const preserved = path.join(mediaDir, "existing.pdf");
        await fs.writeFile(preserved, bytes);
        let active = true;
        const revoked = new Error("Session media authority changed");
        await expect(
          withChannelReadAuthority(
            () => {
              if (!active) {
                throw revoked;
              }
            },
            async () => {
              const saved =
                kind === "buffer"
                  ? await saveMediaBuffer(bytes, "application/pdf", "outbound")
                  : await saveMediaSource(source, undefined, "outbound");
              expect(await fs.readFile(saved.path)).toEqual(bytes);
              active = false;
            },
          ),
        ).rejects.toBe(revoked);
        expect(await fs.readdir(mediaDir)).toEqual(["existing.pdf"]);
        expect(await fs.readFile(preserved)).toEqual(bytes);
      });
    },
  );

  it.skipIf(process.platform === "win32").each([0o600, 0o644])(
    "does not publish unusable permissions when chmod fails (mode=%i)",
    async (mode) => {
      await withOpenClawTestState({ layout: "state-only" }, async (state) => {
        const mediaDir = state.statePath("media", "inbound");
        const chmodError = Object.assign(new Error("synthetic mode finalization failure"), {
          code: "EPERM",
        });
        const open = fs.open.bind(fs);
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          const handle = await open(...args);
          if (
            typeof args[0] === "string" &&
            args[0].startsWith(`${mediaDir}${path.sep}`) &&
            args[1] === "wx"
          ) {
            await handle.chmod(mode);
            vi.spyOn(handle, "chmod").mockRejectedValue(chmodError);
          }
          return handle;
        });
        const operation = withChannelReadAuthority(
          () => {},
          () => saveMediaStream(mediaBytes(), "application/pdf"),
        );
        if (mode === 0o600) {
          await expect(operation).rejects.toBe(chmodError);
          await expect(fs.readdir(mediaDir)).resolves.toEqual([]);
        } else {
          const saved = await operation;
          await expect(fs.readFile(saved.path)).resolves.toEqual(bytes);
        }
      });
    },
  );

  it.each([false, true])(
    "cleans only still-owned staging on orderly process exit (replacement=%s)",
    async (replace) => {
      await withOpenClawTestState({ layout: "state-only" }, async (state) => {
        const mediaDir = state.statePath("media", "inbound");
        const displaced = state.statePath("user-owned.pdf");
        const script = `
          import fs from 'node:fs';
          import path from 'node:path';
          import { withChannelReadAuthority } from './src/shared/channel-read-authority.ts';
          import { saveMediaStream } from './src/media/store.ts';
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
          ["--import", "./scripts/tsx.mjs", "--input-type=module", "-e", script],
          { cwd: process.cwd(), env: { ...process.env, ...state.envVars }, timeout: 20_000 },
        );
        const { stage } = JSON.parse(stdout) as { stage: string };
        if (replace) {
          await expect(fs.readFile(stage, "utf8")).resolves.toBe("replacement");
          await expect(fs.readFile(displaced)).resolves.toEqual(bytes);
        } else {
          await expect(fs.readdir(mediaDir)).resolves.toEqual([]);
        }
      });
    },
  );

  it.each(["replacement", "shared"] as const)(
    "preserves %s staging content when publication is rejected",
    async (kind) => {
      await withOpenClawTestState({ layout: "state-only" }, async (state) => {
        const mediaDir = state.statePath("media", "inbound");
        const displaced = state.statePath("user-owned.pdf");
        let stagedPath: string | undefined;
        const open = fs.open.bind(fs);
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          const handle = await open(...args);
          if (
            typeof args[0] === "string" &&
            args[0].startsWith(`${mediaDir}${path.sep}`) &&
            args[1] === "wx"
          ) {
            stagedPath = args[0];
          }
          return handle;
        });
        const stream = (async function* () {
          yield bytes;
          if (!stagedPath) {
            throw new Error("Expected the media store's exclusive staging write");
          }
          if (kind === "replacement") {
            await fs.rename(stagedPath, displaced);
            await fs.writeFile(stagedPath, "replacement");
          } else {
            await fs.link(stagedPath, displaced);
          }
        })();

        await expect(
          withChannelReadAuthority(
            () => {},
            () => saveMediaStream(stream, "application/pdf"),
          ),
        ).rejects.toThrow(/created file|hardlink|path/i);
        expect(stagedPath).toBeDefined();
        await expect(fs.readFile(stagedPath!)).resolves.toEqual(
          kind === "replacement" ? Buffer.from("replacement") : bytes,
        );
        await expect(fs.readFile(displaced)).resolves.toEqual(bytes);
      });
    },
  );

  it("preserves replacements across repeated disposal in the same read", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      await withChannelReadAuthority(
        () => {},
        async () => {
          const saved = await saveMediaStream(mediaBytes(), "application/pdf");
          const displaced = state.statePath("displaced.pdf");
          await fs.rename(saved.path, displaced);
          await fs.writeFile(saved.path, "replacement");

          await unlinkIfExists(saved.path);
          await unlinkIfExists(saved.path);

          await expect(fs.readFile(saved.path, "utf8")).resolves.toBe("replacement");
          await expect(fs.readFile(displaced)).resolves.toEqual(bytes);
        },
      );
    });
  });

  it("rejects a changed parent alias while preserving its new destination", async () => {
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

    await expect(
      withChannelReadAuthority(
        () => {},
        () => saveMediaStream(stream, "application/pdf"),
      ),
    ).rejects.toThrow(/directory|path|alias/i);
    await expect(fs.readdir(originalMedia)).resolves.toEqual([]);
    await expect(fs.readFile(preserved, "utf8")).resolves.toBe("existing user attachment");
    await expect(fs.readdir(replacementMedia)).resolves.toEqual(["existing.txt"]);
  });

  it("honors a request timeout after its response finishes while the host read remains active", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const mediaDir = state.statePath("media", "inbound");
      await fs.mkdir(mediaDir, { recursive: true });
      const request = new AbortController();
      const timedOut = new Error("synthetic request timeout");
      let hostChecks = 0;
      let sent = false;
      await withChannelReadAuthority(
        () => {
          hostChecks += 1;
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
            { headers: { "content-type": "application/pdf" } },
          );
          await expect(
            saveRemoteMedia({
              url: `https://media.example.test/${randomUUID()}.pdf`,
              requestInit: { signal: request.signal },
              lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
              fetchImpl: async () => response,
            }),
          ).rejects.toBe(timedOut);
          await expect(fs.readdir(mediaDir)).resolves.toEqual([]);
        },
      );
      expect(hostChecks).toBeGreaterThan(0);
    });
  });
});
