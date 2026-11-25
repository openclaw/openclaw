import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { activeSessions } from "../../transcripts/capture-startup.js";
import type { TranscriptSourceProvider } from "../../transcripts/provider-types.js";
import { TranscriptsStore, transcriptSessionSelector } from "../../transcripts/store.js";
import { captureFixture } from "./transcripts-tool.capture-fixture.test-support.js";
import {
  registerTranscriptTestProvider,
  useTranscriptTestState,
} from "./transcripts-tool.test-support.js";

const testState = useTranscriptTestState();
type Authorize = NonNullable<TranscriptSourceProvider["accessControl"]>["authorize"];

function harness() {
  const realNow = Date.now.bind(Date);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.spyOn(Date, "now").mockImplementation(realNow);
  const authorize = vi.fn<Authorize>(async ({ source }) =>
    source.accountId === "private-account"
      ? { ok: false, error: "private provider reason" }
      : { ok: true, value: undefined },
  );
  const accessControl: TranscriptSourceProvider["accessControl"] = {
    channelId: "capture",
    resolveAccountId: ({ source }) => ({ ok: true, value: source.accountId }),
    authorize,
  };
  const f = captureFixture(testState(), { accessControl }, { agentId: "research" });
  const stop = vi.mocked(f.provider.stop!);
  f.provider.start = async (request) => {
    f.requests.push(request);
    await request.onUtterance({ text: `Notes for ${request.session.sessionId}`, final: true });
    return { ok: true, session: request.session };
  };
  registerTranscriptTestProvider(f.provider);
  const execute = (action: string, params: Record<string, unknown> = {}) =>
    f.execute({ action, ...params });
  const start = async (id: string, date: string) => {
    vi.setSystemTime(new Date(`${date}T10:00:00.000Z`));
    return await execute("start", { providerId: f.provider.id, sessionId: id });
  };
  const configuredCapture = (accountId: string, sessionId = "notes") =>
    f.service([{ providerId: "capture", sessionId, accountId }]);
  return { ...f, execute, start, configuredCapture, stop, authorize };
}
const mutatingActions = ["summarize", "stop"];
const ambiguous = /ambiguous.*selector/i;
const notFound = "transcripts session not found";
function textOf(result: Awaited<ReturnType<ReturnType<typeof harness>["execute"]>>) {
  return result.content.find((part) => part.type === "text")?.text ?? "";
}

const collision = [
  { sessionId: "2026-07-03/raw-id", date: "2026-07-04", selector: "2026-07-04/2026-07-03-raw-id" },
  { sessionId: "raw-id", date: "2026-07-03", selector: "2026-07-03/raw-id" },
] as const;
const [legacy, dated] = collision;

describe("transcript tool selection", () => {
  it("rejects legacy collisions before and after retirement", async () => {
    const h = harness();
    const { store } = h;
    for (const target of collision) {
      await h.start(target.sessionId, target.date);
    }
    const rejectLegacy = async () => {
      h.authorize.mockClear();
      for (const action of ["stop", "summarize"]) {
        await expect(h.execute(action, { sessionId: legacy.sessionId })).rejects.toThrow(ambiguous);
      }
      expect(h.authorize).not.toHaveBeenCalled();
    };
    await rejectLegacy();
    expect(h.stop).not.toHaveBeenCalled();
    for (const { session } of h.requests) {
      expect(await store.readSummary(session)).toEqual({});
      const selector = transcriptSessionSelector(session);
      expect((await store.readSession(selector))?.stoppedAt).toBeUndefined();
      await expect(fs.stat(store.sessionDir(session))).rejects.toMatchObject({ code: "ENOENT" });
    }
    const status = await h.execute("status");
    expect(status.details).toMatchObject({
      active: expect.arrayContaining(
        collision.map(({ sessionId, selector }) =>
          expect.objectContaining({ sessionId, selector }),
        ),
      ),
    });
    const statusText = textOf(status);
    const shownSelectors = [...statusText.matchAll(/^active: (.+)$/gm)].map((match) => match[1]);
    expect(shownSelectors).toEqual(collision.map(({ selector }) => selector).toSorted());
    for (const target of collision) {
      const { sessionId } = target;
      const selector = shownSelectors.find((value) => value === target.selector);
      for (const action of ["summarize", "stop", "stop"]) {
        const result = await h.execute(action, { selector });
        expect(result.details).toMatchObject({
          sessionId,
          selector: target.selector,
          summary: { sessionId, transcript: [`Notes for ${sessionId}`] },
        });
        expect(result.content).toContainEqual({
          type: "text",
          text: expect.stringContaining(`Selector: ${target.selector}`),
        });
      }
      expect(h.stop.mock.calls.map(([request]) => request.sessionId)).toEqual(
        collision.slice(0, collision.indexOf(target) + 1).map(({ sessionId: id }) => id),
      );
      await rejectLegacy();
    }
  });

  it("prefers the current exact raw ID only without another identity", async () => {
    const sessionId = "2026-07-03/raw-id";
    const h = harness();
    for (const date of ["2026-07-01", "2026-07-02"]) {
      vi.setSystemTime(new Date(`${date}T10:00:00.000Z`));
      await h.execute("import", { sessionId, transcript: `Historical ${date}` });
    }
    await h.start(sessionId, "2026-07-04");
    for (const action of mutatingActions) {
      expect((await h.execute(action, { sessionId })).details).toMatchObject({
        sessionId,
        summary: { transcript: [`Notes for ${sessionId}`] },
      });
    }
    expect(h.stop).toHaveBeenCalledOnce();
    for (const action of mutatingActions) {
      await expect(h.execute(action, { sessionId })).rejects.toThrow(ambiguous);
      expect(
        (await h.execute(action, { selector: `2026-07-01/${sessionId}` })).details,
      ).toMatchObject({ sessionId, summary: { transcript: ["Speaker: Historical 2026-07-01"] } });
    }
    expect(h.stop).toHaveBeenCalledOnce();
  });

  it("bounds model-visible status selectors without truncating recovery handles", async () => {
    const h = harness();
    const selectors: string[] = [];
    for (const index of [3, 2, 1, 0]) {
      const result = await h.start(`notes-${index}-${"x".repeat(900)}`, "2026-07-04");
      const text = textOf(result);
      const selector = text.match(/\nSelector: (.+)$/)?.[1];
      if (!selector) {
        throw new Error("Start must expose a complete selector to the model");
      }
      selectors.push(selector);
    }
    const failure = vi
      .spyOn(TranscriptsStore.prototype, "writeSession")
      .mockRejectedValueOnce(new Error("store unavailable"));
    await expect(h.requests[0]!.onStatus?.({ active: false })).rejects.toThrow("store unavailable");
    failure.mockRestore();

    const result = await h.execute("status");
    const text = textOf(result);
    const shown = [...text.matchAll(/^(?:pending|active): (.+)$/gm)].map((match) => match[1]);
    expect(shown).toEqual([selectors[0], ...selectors.slice(1).toSorted().slice(0, 2)]);
    expect(text).toContain(`pending: ${selectors[0]}`);
    expect(text).toContain("1 more; ask a local operator to run openclaw transcripts list.");
    expect(text).toContain("\nSelectors:\n");
    expect(text.slice(text.indexOf("Selectors:")).length).toBeLessThanOrEqual(1024);
    expect(text).not.toContain("x".repeat(900));
    for (const selector of shown) {
      expect((await h.execute("summarize", { selector })).details).toMatchObject({ selector });
    }
  });

  it("does not hide a different slug identity behind repeated exact raw IDs", async () => {
    const h = harness();
    await h.start("foo-bar", "2026-07-04");
    for (const [sessionId, date] of [
      ["foo-bar", "2026-07-03"],
      ["foo@bar", "2026-07-01"],
    ] as const) {
      await h.store.writeSession({
        sessionId,
        startedAt: `${date}T10:00:00.000Z`,
        source: { providerId: "capture" },
        metadata: { agentId: "research" },
      });
    }
    for (const action of mutatingActions) {
      await expect(h.execute(action, { sessionId: "foo-bar" })).rejects.toThrow(ambiguous);
    }
    expect(h.stop).not.toHaveBeenCalled();
  });

  it.each(["agent", "account"])(
    "never uses access denial to resolve a collision or disclose %s metadata",
    async (denial) => {
      const h = harness();
      await h.start(legacy.sessionId, legacy.date);
      const accountId = denial === "account" ? "private-account" : "public-account";
      const privateSession = {
        sessionId: "raw-id",
        startedAt: "2026-07-03T10:00:00.000Z",
        title: "private title",
        source: { providerId: "capture", accountId },
        metadata: { agentId: denial === "agent" ? "private-owner" : "research" },
      };
      await h.store.writeSession(privateSession);
      for (const action of ["stop", "summarize"]) {
        h.authorize.mockClear();
        await expect(h.execute(action, { sessionId: legacy.sessionId })).rejects.toThrow(
          /^Ambiguous transcripts session; pass selector from start, import, status, or the local transcripts list\.$/,
        );
        expect(h.authorize).not.toHaveBeenCalled();
        await expect(h.execute(action, { selector: dated.selector })).rejects.toThrow(notFound);
        expect(h.authorize).toHaveBeenCalledTimes(denial === "account" ? 1 : 0);
      }
      expect(h.stop).not.toHaveBeenCalled();
      expect(await h.store.readSummary(privateSession)).toEqual({});
      expect((await h.execute("status")).details).toMatchObject({
        active: [{ sessionId: legacy.sessionId, selector: legacy.selector }],
      });
    },
  );

  it.each(["start", "stop", "show"])(
    "validates selector admission before %s side effects",
    async (action) => {
      const h = harness();
      const rawParams = {
        sessionId: "notes",
        selector: "2026-07-03/notes",
        providerId: "capture",
        transcript: "do not import",
      };
      await expect(h.execute(action, rawParams)).rejects.toThrow(
        action === "start"
          ? /selector.*only.*stop.*summarize/i
          : /exactly one.*selector.*sessionId/i,
      );
      if (action !== "start") {
        await expect(h.execute(action)).rejects.toThrow(/exactly one.*selector.*sessionId/i);
      }
      expect(h.requests).toEqual([]);
      expect(h.authorize).not.toHaveBeenCalled();
      expect(h.stop).not.toHaveBeenCalled();
      expect(await h.store.listSessionEntries()).toEqual([]);
    },
  );

  it("explicit selectors never fall back to a whole raw ID", async () => {
    const h = harness();
    await h.start(legacy.sessionId, legacy.date);
    for (const action of ["stop", "summarize"]) {
      await expect(h.execute(action, { selector: legacy.sessionId })).rejects.toThrow(notFound);
    }
    expect(h.stop).not.toHaveBeenCalled();
  });

  it("keeps configured cleanup bound to its lifecycle token despite a selector collision", async () => {
    const h = harness();
    await h.start(dated.sessionId, dated.date);
    vi.setSystemTime(new Date("2026-07-04T10:00:00.000Z"));
    const service = h.configuredCapture("public-account", legacy.sessionId);
    try {
      await service.start().settled;
      expect(activeSessions.has(legacy.sessionId)).toBe(true);
      await service.stop();
      expect(h.stop.mock.calls.map(([request]) => request.sessionId)).toEqual([legacy.sessionId]);
      await service.stop();
      expect(h.stop).toHaveBeenCalledOnce();
      expect(h.ctx.logger.warn).not.toHaveBeenCalled();
      expect(activeSessions.has(dated.sessionId)).toBe(true);
    } finally {
      await service.stop();
    }
  });

  it("summary retains the admitted private source after a same-tuple public row rewrite", async () => {
    const action = "summarize";
    const h = harness();
    const service = h.configuredCapture("private-account");
    try {
      await service.start().settled;
      expect(activeSessions.has("notes")).toBe(true);
      const session = (await h.store.readSession("notes"))!;
      const selector = transcriptSessionSelector(session);
      await h.store.writeSession({
        ...session,
        source: { ...session.source, accountId: "public-account" },
      });
      expect((await h.store.readSession(selector))?.source.accountId).toBe("public-account");
      h.authorize.mockClear();
      const read = vi.spyOn(TranscriptsStore.prototype, "readUtterancesForSession");
      const write = vi.spyOn(TranscriptsStore.prototype, "writeSummary");
      const materialize = vi.spyOn(TranscriptsStore.prototype, "materializeSessionArtifacts");
      await expect.soft(h.execute(action, { selector })).rejects.toThrow(notFound);
      const authority = expect.objectContaining({ action, source: session.source });
      expect.soft(h.authorize).toHaveBeenCalledExactlyOnceWith(authority);
      expect.soft(h.stop).not.toHaveBeenCalled();
      expect.soft(read).not.toHaveBeenCalled();
      expect.soft(write).not.toHaveBeenCalled();
      expect.soft(materialize).not.toHaveBeenCalled();
      expect.soft(await h.store.readSummary(session)).toEqual({});
      expect.soft((await h.store.readSession(selector))?.stoppedAt).toBeUndefined();
      await expect
        .soft(fs.stat(h.store.sessionDir(session)))
        .rejects.toMatchObject({ code: "ENOENT" });
      await service.stop();
      expect(h.stop).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ sessionId: "notes", source: session.source }),
      );
      expect(await h.store.readSummary(session)).toMatchObject({
        summary: { transcript: ["Notes for notes"] },
      });
    } finally {
      await service.stop();
    }
  });
});
