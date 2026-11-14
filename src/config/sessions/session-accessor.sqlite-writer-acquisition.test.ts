import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { expect, it as baseIt, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { applySessionEntryCanonicalReplacements } from "./session-accessor.sqlite-replacement-projection.js";
import { withSessionEntryWorker } from "./session-accessor.sqlite-replacement-worker.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";

const it = baseIt.extend<{ state: OpenClawTestState }>({
  state: [
    async ({ task: _task }, use) => withOpenClawTestState({ scenario: "minimal" }, use),
    { auto: true },
  ],
});

it("does not recapture synchronous filesystem identity during a public replacement", async ({
  state,
}) => {
  const databasePath = state.statePath("replacement.sqlite");
  const sessionKey = "agent:main:writer-acquisition";
  const agentDatabasePath = resolveOpenClawAgentSqlitePath(
    toDatabaseOptions(
      resolveSqliteScope({
        agentId: "main",
        storePath: databasePath,
        env: state.env,
        sessionKey,
      }),
    ),
  );
  const captures: string[] = [];
  const record = (kind: string) => {
    const stack = new Error().stack ?? "";
    if (stack.includes("withSessionEntryWorker")) {
      captures.push(`${kind}\n${stack}`);
    }
  };
  const stat = fs.statSync;
  const realpath = fs.realpathSync.native;
  const spies = [
    vi.spyOn(fs, "statSync").mockImplementation((...args: Parameters<typeof fs.statSync>) => {
      record("statSync");
      return Reflect.apply(stat, fs, args);
    }),
    vi
      .spyOn(fs.realpathSync, "native")
      .mockImplementation((...args: Parameters<typeof fs.realpathSync.native>) => {
        record("realpathSync.native");
        return Reflect.apply(realpath, fs.realpathSync, args);
      }),
  ];
  syncBuiltinESMExports();
  try {
    await expect(
      applySessionEntryCanonicalReplacements({
        agentId: "main",
        storePath: databasePath,
        env: state.env,
        sessionKeys: [sessionKey],
        update: () => ({
          result: "committed",
          replacements: [
            {
              sessionKey,
              previousSessionKeys: [],
              entry: { sessionId: "synthetic", updatedAt: 1 },
            },
          ],
        }),
      }),
    ).resolves.toBe("committed");
    expect((await fsPromises.stat(agentDatabasePath)).isFile()).toBe(true);
    expect(captures).toEqual([]);
  } finally {
    for (const spy of spies) {
      spy.mockRestore();
    }
    syncBuiltinESMExports();
  }
});

it.for(["fifo", "retire", "appeared", "replaced"] as const)(
  "keeps writer acquisition ownership while the initial filesystem lookup waits (%s)",
  async (mode, { state }) => {
    const options = { agentId: "main", path: state.statePath("queued.sqlite"), env: state.env };
    const successorPath = state.statePath("successor.sqlite");
    if (mode === "appeared" || mode === "replaced") {
      openOpenClawAgentDatabase({ ...options, path: successorPath });
      await closeOpenClawAgentDatabaseByPathAsync(successorPath, options.agentId);
      if (mode === "replaced") {
        await fsPromises.copyFile(successorPath, options.path);
      }
    }
    const entered = createDeferred();
    const release = createDeferred();
    const stat = fsPromises.stat;
    let blocked = false;
    let executing = false;
    const spy = vi
      .spyOn(fsPromises, "stat")
      .mockImplementation(async (...args: Parameters<typeof fsPromises.stat>) => {
        if (!blocked && !executing && args[0] === options.path) {
          blocked = true;
          const observed = await Reflect.apply(stat, fsPromises, args).then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          entered.resolve();
          await release.promise;
          if (!observed.ok) {
            throw observed.error;
          }
          return observed.value;
        }
        return Reflect.apply(stat, fsPromises, args);
      });
    syncBuiltinESMExports();
    const order: string[] = [];
    const run = (label: string) =>
      withSessionEntryWorker(
        options,
        undefined,
        () => {},
        async (execution, source) => {
          executing = true;
          await execution.prepare(source);
          order.push(label);
        },
      );
    const first = run("first");
    const outcome = first.then(
      () => ({ ok: true }),
      (error: unknown) => ({ ok: false, error }),
    );
    let second: Promise<void> | undefined;
    try {
      await Promise.race([entered.promise, first]);
      expect(blocked).toBe(true);
      if (mode === "retire") {
        await closeOpenClawAgentDatabaseByPathAsync(options.path, options.agentId);
      } else if (mode === "fifo") {
        second = run("second");
      } else {
        await fsPromises.copyFile(successorPath, `${options.path}.replacement`);
        await fsPromises.rename(`${options.path}.replacement`, options.path);
      }
      expect(order).toEqual([]);
      release.resolve();
      if (mode !== "fifo") {
        expect(await outcome).toMatchObject({ ok: false });
        expect(order).toEqual([]);
        if (mode === "retire") {
          await run("successor");
          expect(order).toEqual(["successor"]);
        } else {
          expect(await fsPromises.readFile(options.path)).toEqual(
            await fsPromises.readFile(successorPath),
          );
        }
      } else {
        await Promise.all([first, second]);
        expect(order).toEqual(["first", "second"]);
      }
    } finally {
      release.resolve();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
      spy.mockRestore();
      syncBuiltinESMExports();
    }
  },
);
