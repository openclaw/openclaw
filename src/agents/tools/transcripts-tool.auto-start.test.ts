import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { hasTerminalControl } from "../../../packages/terminal-core/src/safe-text.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { createTranscriptsAutoStartService } from "../../transcripts/auto-start.js";
import type {
  TranscriptSourceProvider,
  TranscriptStartRequest,
} from "../../transcripts/provider-types.js";
import { TranscriptsStore } from "../../transcripts/store.js";
import { createTranscriptsTool } from "./transcripts-tool.js";
import { useTranscriptTestState } from "./transcripts-tool.test-support.js";

const testState = useTranscriptTestState();
const capturedText = "Private captured decision: keep these notes out of operator logs.";
const obstruction = "existing file; do not overwrite\n";
const credential = "fixture-secret-value-1234567890";
const providerError = `fixture stop failure\n\u001b[31mred\u001b[0m\u0085 token=${credential} ${"🦞".repeat(2_000)}`;
async function fixture(
  providers: TranscriptSourceProvider[],
  autoStart: NonNullable<NonNullable<OpenClawConfig["transcripts"]>["autoStart"]>,
) {
  const stateDir = await fs.realpath(testState().stateDir);
  const options = { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
  const exportRoot = path.join(stateDir, "transcripts");
  const logger = { warn: vi.fn<(message: string) => void>() };
  const scoped = createEmptyPluginRegistry();
  for (const provider of providers) {
    scoped.transcriptSourceProviders.push({
      pluginId: provider.id,
      provider,
      source: import.meta.url,
    });
  }
  const ctx = {
    config: { transcripts: { autoStart } },
    stateDir,
    logger,
    caller: { kind: "operator" as const, source: "local" as const },
  };
  const service = createTranscriptsAutoStartService(ctx);
  const tool = createTranscriptsTool(ctx);
  const store = () => new TranscriptsStore(exportRoot, options);
  const execute = (action: string, sessionId?: string) =>
    tool.execute("auto-start", { action, providerId: providers[0]!.id, sessionId });
  return {
    service,
    logger,
    store,
    execute,
    status: (active: unknown) =>
      expect(execute("status")).resolves.toMatchObject({ details: { active } }),
    scope: (run: () => Promise<void>) => withPluginRuntimeRegistryScope(scoped, run),
  };
}

it.each(["returned failure", "terminal warning", "manual export"] as const)(
  "%s preserves state and finishes siblings",
  async (outcome) => {
    const manual = outcome === "manual export";
    const blocked = outcome !== "returned failure";
    const needsRetry = !blocked;
    const ids = ["subject", "healthy-sibling"];
    const requests = new Map<string, TranscriptStartRequest>();
    let cleanupFails = !manual;
    const stop = vi.fn<NonNullable<TranscriptSourceProvider["stop"]>>(async ({ sessionId }) => {
      if (sessionId === "subject" && cleanupFails) {
        if (outcome === "terminal warning") {
          await requests.get(sessionId)!.onStatus?.({ active: false });
        }
        return { ok: false, error: providerError };
      }
      return { ok: true, sessionId };
    });
    const provider: TranscriptSourceProvider = {
      id: "stop-reporting-fixture",
      name: "Stop reporting fixture",
      sourceKinds: ["live-caption"],
      start: async (request) => {
        requests.set(request.session.sessionId, request);
        return { ok: true, session: request.session };
      },
      stop,
    };
    const f = await fixture(
      [provider],
      ids.map((sessionId) => ({ providerId: provider.id, sessionId })),
    );
    await f.scope(async () => {
      try {
        await f.service.start().settled;
        for (const id of ids) {
          const request = requests.get(id)!;
          await request.onUtterance({ text: capturedText, final: true });
        }
        const subject = requests.get("subject")!.session;
        const sessionDir = f.store().sessionDir(subject);
        const summaryPath = path.join(sessionDir, "summary.md");
        if (blocked) {
          await fs.mkdir(path.dirname(sessionDir), { recursive: true });
          await fs.writeFile(sessionDir, obstruction, { flag: "wx" });
        }
        if (manual) {
          const result = await f.execute("stop", "subject");
          expect(result.details).toMatchObject({
            summaryExportError: expect.stringContaining("ENOTDIR"),
            intendedSummaryPath: summaryPath,
            summary: { utteranceCount: 1 },
          });
          expect(result.details).not.toHaveProperty("summaryPath");
          expect(result.details).not.toHaveProperty("providerStopError");
        }
        await expect(f.service.stop()).resolves.toBeUndefined();
        expect(stop.mock.calls.map(([request]) => request.sessionId)).toEqual(ids);
        const warnings = f.logger.warn.mock.calls.map(([message]) => message);
        await closeOpenClawStateDatabaseAsync();
        const reopened = f.store();
        for (const id of ids) {
          const stored = (await reopened.readSession(id))!;
          const summary = await reopened.readSummary(stored);
          if (id === "subject" && needsRetry) {
            expect(stored.stoppedAt).toBeUndefined();
            expect(summary).toEqual({});
          } else {
            expect(stored.stoppedAt).toEqual(expect.any(String));
            expect(summary).toMatchObject({
              summary: { utteranceCount: 1, transcript: [capturedText] },
              markdown: expect.stringContaining(capturedText),
            });
            if (id === "subject" && blocked) {
              expect(await fs.readFile(sessionDir, "utf8")).toBe(obstruction);
              await expect(fs.readFile(summaryPath)).rejects.toMatchObject({ code: "ENOTDIR" });
            } else {
              expect(
                await fs.readFile(path.join(reopened.sessionDir(stored), "summary.md"), "utf8"),
              ).toContain(capturedText);
            }
          }
        }
        await f.status(needsRetry ? [{ sessionId: "subject" }] : []);
        if (manual) {
          expect(warnings).toEqual([]);
        } else {
          expect(warnings.length).toBeGreaterThan(0);
          const logged = warnings.join(" ");
          expect(logged).toContain("subject");
          if (blocked) {
            expect(logged).toMatch(/summary saved.*export failed/i);
            expect(logged).toContain("ENOTDIR");
            expect(logged).toContain(JSON.stringify(summaryPath));
            expect(logged).toContain("openclaw transcripts path <session>");
            expect(logged).toMatch(/(?:repair|correct).*destination/i);
          }
          expect(logged).toContain("fixture stop failure");
          expect(logged).toMatch(/stop failed/);
          for (const warning of warnings) {
            expect(warning.length).toBeLessThanOrEqual(2_200);
            expect(hasTerminalControl(warning)).toBe(false);
            expect(warning).not.toMatch(/[\uD800-\uDFFF]/u);
            for (const forbidden of [credential, capturedText, '"transcript":']) {
              expect(warning).not.toContain(forbidden);
            }
          }
        }
        cleanupFails = false;
        await f.service.stop();
        expect((await f.store().readSummary(subject)).summary?.transcript).toEqual([capturedText]);
        expect(stop.mock.calls.map(([request]) => request.sessionId)).toEqual(
          needsRetry ? [...ids, "subject"] : ids,
        );
        expect(f.logger.warn.mock.calls.map(([message]) => message)).toEqual(warnings);
        await f.status([]);
      } finally {
        cleanupFails = false;
        await f.service.stop();
        for (const id of requests.keys()) {
          await f.execute("stop", id);
        }
      }
    });
  },
);

it.each(["replacement abort", "title write failure"] as const)(
  "retains cleanup and resumes after %s",
  async (fault) => {
    const release = createDeferred();
    const entered = createDeferred();
    const requests: TranscriptStartRequest[] = [];
    const stop = vi.fn<NonNullable<TranscriptSourceProvider["stop"]>>(async () => ({
      ok: false,
      error: "fixture capture still owns resources",
    }));
    const provider: TranscriptSourceProvider = {
      id: "continuous-fixture",
      name: "Continuous fixture",
      sourceKinds: ["live-caption"],
      start: async (request) => {
        requests.push(request);
        entered.resolve();
        await release.promise;
        return { ok: true, session: { ...request.session, title: "Provider title" } };
      },
      stop,
    };
    const f = await fixture([provider], [{ providerId: provider.id }]);
    const store = f.store();
    const originalWrite = store.writeSession.bind(store);
    let rejectedTitle = false;
    const writeSession = vi
      .spyOn(TranscriptsStore.prototype, "writeSession")
      .mockImplementation(async (session) => {
        if (fault === "title write failure" && session.title && !rejectedTitle) {
          rejectedTitle = true;
          throw new Error("fixture title write unavailable");
        }
        await originalWrite(session);
      });
    const affected = new Set([provider.id]);
    let pendingStop: Promise<void> | undefined;
    await f.scope(async () => {
      try {
        const startup = f.service.start().settled;
        await entered.promise;
        expect(requests).toHaveLength(1);
        const original = requests[0]!;
        const sessionId = original.session.sessionId;
        if (fault === "replacement abort") {
          pendingStop = f.service.stop(affected);
          const stopped = pendingStop.catch((error: unknown) => error);
          expect(original.abortSignal?.aborted).toBe(true);
          release.resolve();
          expect(await stopped).toBeInstanceOf(AggregateError);
          expect(stop).toHaveBeenCalledTimes(2);
        } else {
          release.resolve();
          await startup;
          expect(f.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining(
              "admitted-start-failed. Check Meeting capture health in Settings.",
            ),
          );
          expect(stop).toHaveBeenCalledOnce();
          expect(original.abortSignal?.aborted).toBe(false);
        }
        await f.status([{ sessionId }]);
        await expect(f.execute("start", sessionId)).rejects.toThrow(
          "transcripts session already active",
        );
        expect(requests).toHaveLength(1);
        await original.onUtterance({ text: "late failed capture", final: true });
        expect(await store.readUtterancesForSession(original.session)).toEqual([]);
        const previousStops = stop.mock.calls.length;
        stop.mockImplementation(async (request) => ({ ok: true, sessionId: request.sessionId }));
        await f.service.stop(affected);
        expect(stop).toHaveBeenCalledTimes(previousStops + 1);
        await f.status([]);
        await f.service.start().settled;
        expect(requests).toHaveLength(2);
        const current = requests[1]!;
        await f.status([{ sessionId: current.session.sessionId }]);
        await original.onUtterance({ text: "stale replaced capture", final: true });
        expect(current.session.sessionId).not.toBe(sessionId);
        await current.onUtterance({ text: "current capture", final: true });
        expect(
          (await store.readUtterancesForSession(current.session)).map((row) => row.text),
        ).toEqual(["current capture"]);
      } finally {
        release.resolve();
        writeSession.mockRestore();
        stop.mockImplementation(async (request) => ({ ok: true, sessionId: request.sessionId }));
        await pendingStop?.catch(() => {});
        await f.service.stop();
        for (const request of requests) {
          await f.execute("stop", request.session.sessionId);
        }
      }
    });
  },
);
