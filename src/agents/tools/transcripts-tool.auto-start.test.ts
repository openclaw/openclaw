import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { hasTerminalControl } from "../../../packages/terminal-core/src/safe-text.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import type {
  TranscriptSourceProvider,
  TranscriptStartRequest,
} from "../../transcripts/provider-types.js";
import { TranscriptsStore } from "../../transcripts/store.js";
import {
  captureFixture,
  captureGate,
  type CaptureStop,
} from "./transcripts-tool.capture-fixture.test-support.js";
import { useTranscriptTestState } from "./transcripts-tool.test-support.js";

const testState = useTranscriptTestState();
const capturedText = "Private captured decision: keep these notes out of operator logs.";
const obstruction = "existing file; do not overwrite\n";
const credential = "fixture-secret-value-1234567890";
const providerError = `fixture stop failure\n\u001b[31mred\u001b[0m\u0085 token=${credential} ${"🦞".repeat(2_000)}`;
async function fixture(provider: Pick<TranscriptSourceProvider, "start" | "stop">, ids?: string[]) {
  const stateDir = await fs.realpath(testState().stateDir);
  const autoStart = (ids ?? [undefined]).map((sessionId) => ({ providerId: "capture", sessionId }));
  const f = captureFixture({ stateDir }, provider, { config: { transcripts: { autoStart } } });
  const execute = (action: string, sessionId?: string) =>
    f.execute({ action, providerId: f.provider.id, sessionId });
  return { ...f, service: f.service(autoStart), store: f.newStore, execute };
}

it.each(["terminal warning", "manual export"] as const)(
  "%s preserves state and finishes siblings",
  async (outcome) => {
    const manual = outcome === "manual export";
    const ids = ["subject", "healthy-sibling"];
    const requestFor = (id: string): TranscriptStartRequest =>
      f.requests.find(({ session }) => session.sessionId === id)!;
    let cleanupFails = !manual;
    const stop = vi.fn<CaptureStop>(async ({ sessionId }) => {
      if (sessionId === "subject" && cleanupFails) {
        await requestFor(sessionId).onStatus?.({ active: false });
        return { ok: false, error: providerError };
      }
      return { ok: true, sessionId };
    });
    const f = await fixture({ stop }, ids);
    await f.scope(async () => {
      try {
        await f.service.start().settled;
        for (const id of ids) {
          await requestFor(id).onUtterance({ text: capturedText, final: true });
        }
        const subject = requestFor("subject").session;
        const sessionDir = f.store().sessionDir(subject);
        const summaryPath = path.join(sessionDir, "summary.md");
        await fs.mkdir(path.dirname(sessionDir), { recursive: true });
        await fs.writeFile(sessionDir, obstruction, { flag: "wx" });
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
          expect(stored.stoppedAt).toEqual(expect.any(String));
          expect(await reopened.readSummary(stored)).toMatchObject({
            summary: { utteranceCount: 1, transcript: [capturedText] },
            markdown: expect.stringContaining(capturedText),
          });
          if (id === "subject") {
            expect(await fs.readFile(sessionDir, "utf8")).toBe(obstruction);
            await expect(fs.readFile(summaryPath)).rejects.toMatchObject({ code: "ENOTDIR" });
          } else {
            expect(
              await fs.readFile(path.join(reopened.sessionDir(stored), "summary.md"), "utf8"),
            ).toContain(capturedText);
          }
        }
        await f.status([]);
        if (manual) {
          expect(warnings).toEqual([]);
        } else {
          const logged = warnings.join(" ");
          expect(logged).toMatch(/summary saved.*export failed/i);
          expect(logged).toContain("ENOTDIR");
          expect(logged).toContain(JSON.stringify(summaryPath));
          expect(logged).toContain("openclaw transcripts path <session>");
          expect(logged).toMatch(/(?:repair|correct).*destination/i);
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
        await f.service.stop();
        expect((await f.store().readSummary(subject)).summary?.transcript).toEqual([capturedText]);
        expect(stop.mock.calls.map(([request]) => request.sessionId)).toEqual(ids);
        expect(f.logger.warn.mock.calls.map(([message]) => message)).toEqual(warnings);
        await f.status([]);
      } finally {
        cleanupFails = false;
        await f.service.stop();
      }
    });
  },
);

it.each(["replacement abort", "title write failure"] as const)(
  "retains cleanup and resumes after %s",
  async (fault) => {
    const gate = captureGate();
    const requests: TranscriptStartRequest[] = [];
    const stop = vi.fn<CaptureStop>(async () => ({ ok: false, error: "resources still owned" }));
    const f = await fixture({
      start: async (request) => {
        requests.push(request);
        await gate.wait();
        return { ok: true, session: { ...request.session, title: "Provider title" } };
      },
      stop,
    });
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
        return originalWrite(session);
      });
    const affected = new Set([f.provider.id]);
    let pendingStop: Promise<void> | undefined;
    await f.scope(async () => {
      try {
        const startup = f.service.start().settled;
        await gate.entered;
        expect(requests).toHaveLength(1);
        const original = requests[0]!;
        const sessionId = original.session.sessionId;
        if (fault === "replacement abort") {
          pendingStop = f.service.stop(affected);
          const stopped = pendingStop.catch((error: unknown) => error);
          expect(original.abortSignal?.aborted).toBe(true);
          gate.release();
          expect(await stopped).toBeInstanceOf(AggregateError);
        } else {
          gate.release();
          await startup;
          const diagnostic = "admitted-start-failed. Check Meeting capture health in Settings.";
          expect(f.logger.warn).toHaveBeenCalledWith(expect.stringContaining(diagnostic));
          expect(original.abortSignal?.aborted).toBe(false);
        }
        expect(stop).toHaveBeenCalledTimes(fault === "replacement abort" ? 2 : 1);
        await f.status([{ sessionId }]);
        const collision = f.execute("start", sessionId);
        await expect(collision).rejects.toThrow("transcripts session already active");
        expect(requests).toHaveLength(1);
        await original.onUtterance({ text: "late failed capture", final: true });
        expect(await store.readUtterancesForSession(original.session)).toEqual([]);
        const previousStops = stop.mock.calls.length;
        stop.mockImplementation(f.successfulStop);
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
        const utterances = await store.readUtterancesForSession(current.session);
        expect(utterances.map((row) => row.text)).toEqual(["current capture"]);
      } finally {
        gate.release();
        writeSession.mockRestore();
        stop.mockImplementation(f.successfulStop);
        await pendingStop?.catch(() => {});
        await f.service.stop();
      }
    });
  },
);
