import fs from "node:fs/promises";
import type { Server } from "node:http";
import { setImmediate } from "node:timers/promises";
import { promisify } from "node:util";
import { collectErrorGraphCandidates } from "@openclaw/normalization-core/error-coercion";
import { expect, it, vi, type TestContext } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "./promise.js";

type Evidence = typeof import("../e2e/qa-lab/runtime/script-evidence.js");
type Wire = typeof import("../e2e/qa-lab/runtime/paired-node-worker-wire-fixture.js");
type MockFactory = Extract<Parameters<typeof vi.doMock>[1], (...args: never[]) => unknown>;
const generationModule = "../e2e/qa-lab/runtime/worker-inference-generation-reload.js";

it.for(["cancelled import", "failed import", "failed evidence", "cancelled close"] as const)(
  "joins generation work before reset and the next case (%s)",
  (fault, context) => {
    const work = Promise.resolve().then(async () => {
      let after!: () => unknown;
      const cases: Array<(context: TestContext) => Promise<unknown>> = [];
      const gate = createDeferred();
      const importing = createDeferred();
      const controller = new AbortController();
      const reason = new Error(`injected ${fault}`);
      const signal = AbortSignal.any([context.signal, controller.signal]);
      const servers: Server[] = [];
      let firstCase = true;
      const resets: boolean[] = [];
      const writes: Array<{ artifactBase: string; details?: string }> = [];
      const roots = new Set<string>();
      const originalProcess = { argv: process.argv, exitCode: process.exitCode };
      const tmpdir = process.env.TMPDIR;
      const remove = fs.rm;
      let released = false;
      let first: Promise<unknown> | undefined;
      let teardown: Promise<unknown> | undefined;
      const mocks = new Set<string>();
      const reset = (ids: Iterable<string>) => {
        for (const id of ids) {
          vi.doUnmock(id);
        }
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        vi.resetModules();
      };
      vi.doMock("vitest", () => ({
        expect,
        describe: (_name: string, body: () => void) => body(),
        // Only the generation table is exercised; sibling bodies stay in their own suite.
        it: Object.assign(() => {}, {
          each: () => () => {},
          for:
            (values: string[]) =>
            (_name: string, body: (value: string, context: TestContext) => Promise<unknown>) => {
              cases.push(...values.map((value) => (ctx: TestContext) => body(value, ctx)));
            },
        }),
        afterEach: (hook: () => unknown) => (after = hook),
        vi: {
          ...vi,
          doMock: (id: string, factory: MockFactory) => {
            mocks.add(id);
            if (id.endsWith("/script-evidence.js")) {
              vi.doMock(id, async (importOriginal) => {
                const original = (await factory(importOriginal)) as Evidence;
                return {
                  createQaScriptEvidenceWriter: (
                    options: Parameters<Evidence["createQaScriptEvidenceWriter"]>[0],
                  ) => {
                    const writer = original.createQaScriptEvidenceWriter(options);
                    return {
                      ...writer,
                      async write(result: Parameters<typeof writer.write>[0]) {
                        writes.push({ artifactBase: options.artifactBase, ...result });
                        if (firstCase && fault === "failed evidence") {
                          throw reason;
                        }
                        return await writer.write(result);
                      },
                    };
                  },
                };
              });
            } else if (id.endsWith("/paired-node-worker-wire-fixture.js")) {
              vi.doMock(id, async (importOriginal) => {
                const original = (await factory(importOriginal)) as Wire;
                return {
                  ...original,
                  async closeWireServer(server: Server) {
                    servers.push(server);
                    if (firstCase && fault === "cancelled close") {
                      controller.abort(reason);
                    }
                    await original.closeWireServer(server);
                  },
                };
              });
            } else {
              vi.doMock(id, factory);
            }
          },
          doUnmock: (id: string) => {
            resets.push(released);
            // Record premature reset without letting pre-fix code start real services.
            return released && vi.doUnmock(id);
          },
          restoreAllMocks: () => released && vi.restoreAllMocks(),
          unstubAllEnvs: () => released && vi.unstubAllEnvs(),
          resetModules: () => released && vi.resetModules(),
          stubEnv: (key: string, value: string) => {
            roots.add(value);
            return vi.stubEnv(key, value);
          },
        },
      }));
      vi.doMock(generationModule, async (original) => {
        importing.resolve();
        await gate.promise;
        if (fault === "failed import") {
          throw reason;
        }
        return await original();
      });
      try {
        await import("./qa-gateway-cleanup.test.js");
        first = cases[0]!({ ...context, signal }).catch((error: unknown) => error);
        await awaitGateBeforeSettlement(
          importing.promise,
          first,
          "generation case ended before the import barrier",
        );
        if (fault === "cancelled import") {
          controller.abort(reason);
        }
        // Vitest can start teardown while the cancelled body is still pending.
        let teardownDone = false;
        teardown = Promise.resolve(after()).then(() => (teardownDone = true));
        await setImmediate();
        const resetBeforeJoin = resets.includes(false);
        const completedBeforeJoin = teardownDone;
        released = true;
        gate.resolve();
        const outcome = await first;
        await teardown;
        const firstWrites = [...writes];
        vi.doUnmock(generationModule);
        reset(mocks);
        firstCase = false;
        await cases[1]!(context);
        await after();
        expect([resetBeforeJoin, completedBeforeJoin]).toEqual([false, false]);
        expect(collectErrorGraphCandidates(outcome, (error) => [error.cause])).toContain(reason);
        const firstWriteCount = fault === "failed evidence" || fault === "cancelled close" ? 1 : 0;
        expect(firstWrites).toHaveLength(firstWriteCount);
        expect(writes).toHaveLength(firstWriteCount + 1);
        expect(writes.at(-1)?.details).toContain("generation shutdown unconfirmed");
        expect(servers).toHaveLength(firstWriteCount + 1);
        for (const server of servers) {
          expect(server.listening).toBe(false);
          expect(await promisify(server.getConnections.bind(server))()).toBe(0);
        }
        expect(process.argv).toBe(originalProcess.argv);
        expect(process.exitCode).toBe(originalProcess.exitCode);
        expect(process.env.TMPDIR).toBe(tmpdir);
        expect(fs.rm).toBe(remove);
        const [firstRoot, secondRoot] = [...roots];
        expect(writes.at(-1)?.artifactBase).toBe(`${secondRoot}/evidence`);
        for (const write of firstWrites) {
          expect(write.artifactBase).toBe(`${firstRoot}/evidence`);
        }
        for (const root of roots) {
          await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
        }
      } finally {
        released = true;
        gate.resolve();
        try {
          await first;
          await teardown;
        } finally {
          reset(["vitest", generationModule, ...mocks]);
          Object.assign(process, originalProcess);
          for (const root of roots) {
            await fs.rm(root, { recursive: true, force: true });
          }
        }
      }
    });
    context.onTestFinished(() => work.catch(() => {}));
    return work;
  },
);
