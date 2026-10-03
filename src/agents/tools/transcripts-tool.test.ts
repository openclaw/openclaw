import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createTranscriptsAutoStartService } from "../../transcripts/auto-start.js";
import { startTranscripts } from "../../transcripts/capture.js";
import type {
  TranscriptSourceProvider,
  TranscriptStartRequest,
} from "../../transcripts/provider-types.js";
import { createTranscriptsTool } from "./transcripts-tool.js";
import {
  registerTranscriptTestProvider,
  useTranscriptTestState,
} from "./transcripts-tool.test-support.js";

type Start = NonNullable<TranscriptSourceProvider["start"]>;
type Stop = NonNullable<TranscriptSourceProvider["stop"]>;
const testState = useTranscriptTestState();
const plugins = { allow: ["transcript-test-fixture"] };
const startCapture: Start = async ({ session }) => ({ ok: true, session });
const stopCapture: Stop = async ({ sessionId }) => ({ ok: true, sessionId });

function harness(overrides: Partial<TranscriptSourceProvider> = {}, config: OpenClawConfig = {}) {
  const { stateDir, store } = testState();
  const logger = { warn: vi.fn() };
  const provider: TranscriptSourceProvider = {
    id: "proof-live",
    name: "Proof Live",
    sourceKinds: ["live-caption"],
    start: startCapture,
    stop: stopCapture,
    ...overrides,
  };
  registerTranscriptTestProvider(provider, "transcript-test-fixture");
  const ctx = {
    config: { plugins, transcripts: { enabled: true }, ...config },
    stateDir,
    logger,
    caller: { kind: "operator", source: "local" },
  } as const;
  const toolFor = (agentId?: string) => createTranscriptsTool({ ...ctx, agentId });
  const tool = toolFor();
  const execute = (action: string, sessionId?: string) =>
    tool.execute(action, { action, sessionId });
  const start = (signal?: AbortSignal) =>
    tool.execute("start", { action: "start", providerId: provider.id, sessionId: "notes" }, signal);
  const session = async () => {
    const value = await store.readSession("notes");
    if (!value) {
      throw new Error("Expected captured session");
    }
    return value;
  };
  return {
    ...ctx,
    provider,
    toolFor,
    execute,
    start,
    store,
    session,
    service: createTranscriptsAutoStartService(ctx),
  };
}

describe("transcripts tool", () => {
  it("keeps capturing after the initiating agent run ends", async () => {
    const controller = new AbortController();
    let request: TranscriptStartRequest | undefined;
    const h = harness({
      start: async (value) => {
        request = value;
        return startCapture(value);
      },
    });
    await h.start(controller.signal);
    expect(request?.abortSignal).not.toBe(controller.signal);
    controller.abort();
    expect(request?.abortSignal?.aborted).toBe(false);
    const text = "captured after the start action completed\nsecond\tcolumn";
    await request!.onUtterance({ text, final: true });
    const session = await h.session();
    await expect(h.store.readUtterancesForSession(session)).resolves.toEqual([
      expect.objectContaining({ text }),
    ]);
    await h.execute("stop", "notes");
    await expect(
      fs.readFile(path.join(h.store.sessionDir(session), "summary.md"), "utf8"),
    ).resolves.toContain("captured after the start action completed\\nsecond\\tcolumn");
  });

  it("drops late speech and retains repeated abort cleanup failures until retry succeeds", async () => {
    const controller = new AbortController();
    let failures = 2;
    const stop = vi.fn<Stop>(async (request) =>
      failures-- > 0 ? { ok: false, error: "voice cleanup failed" } : stopCapture(request),
    );
    const start = vi.fn<Start>(async (request) => {
      expect(request.abortSignal).not.toBe(controller.signal);
      expect(request.abortSignal?.aborted).toBe(false);
      controller.abort();
      expect(request.abortSignal?.aborted).toBe(true);
      await request.onUtterance({ text: "captured after agent cancellation", final: true });
      return startCapture(request);
    });
    const h = harness({ start, stop });
    await expect(h.start(controller.signal)).rejects.toThrow(
      "transcripts start aborted; provider cleanup failed: voice cleanup failed",
    );
    await expect(h.store.readUtterancesForSession(await h.session())).resolves.toEqual([]);
    expect(stop).toHaveBeenCalledOnce();
    await expect(h.start()).rejects.toThrow("transcripts session already active: notes");
    expect(start).toHaveBeenCalledOnce();
    await expect(h.execute("stop", "notes")).rejects.toThrow(
      "transcripts provider cleanup failed: voice cleanup failed",
    );
    expect(stop).toHaveBeenCalledTimes(2);
    await h.execute("stop", "notes");
    expect(stop).toHaveBeenCalledTimes(3);
  });

  it("reserves a session while provider startup is pending", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    const start = vi.fn<Start>(async (request) => {
      entered.resolve();
      await release.promise;
      return startCapture(request);
    });
    const stop = vi.fn(stopCapture);
    const h = harness({ start, stop });
    const pending = h.start();
    await entered.promise;
    try {
      await expect(h.start()).rejects.toThrow("transcripts session already active: notes");
      await expect(h.execute("stop", "notes")).resolves.toMatchObject({
        details: { sessionId: "notes", skipped: true },
      });
      expect(stop).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await pending;
      await h.execute("stop", "notes");
    }
    expect(start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("keeps missing abort cleanup hooks visible until the provider can stop", async () => {
    const controller = new AbortController();
    const h = harness({
      start: async (request) => {
        controller.abort();
        return startCapture(request);
      },
    });
    delete h.provider.stop;
    const error = "transcripts provider proof-live cannot stop live capture";
    await expect(h.start(controller.signal)).rejects.toThrow(
      `transcripts start aborted; provider cleanup failed: ${error}`,
    );
    await expect(h.execute("stop", "notes")).rejects.toThrow(
      `transcripts provider cleanup failed: ${error}`,
    );
    const stop = vi.fn(stopCapture);
    h.provider.stop = stop;
    await h.execute("stop", "notes");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("lets the routed agent read auto-started notes with the resolved account", async () => {
    const entered = createDeferred<TranscriptStartRequest>();
    const start = vi.fn<Start>(async (request) => {
      await request.onUtterance({ text: "Decision: keep meeting notes with their routed agent." });
      entered.resolve(request);
      return startCapture(request);
    });
    const h = harness(
      {
        id: "room-audio",
        start,
        accessControl: {
          channelId: "discord",
          resolveAccountId: () => ({ ok: true, value: "account-a" }),
          authorize: async ({ caller, source }) =>
            caller.kind === "operator" ||
            (caller.channel === "discord" && caller.accountId === source.accountId)
              ? { ok: true, value: undefined }
              : { ok: false, error: "account denied" },
        },
      },
      {
        agents: { entries: { main: {}, research: {} } },
        bindings: [
          {
            type: "route",
            agentId: "research",
            match: {
              channel: "discord",
              accountId: "account-a",
              peer: { kind: "channel", id: "room-a" },
            },
          },
        ],
        transcripts: {
          autoStart: [{ providerId: "room-audio", guildId: "guild-a", channelId: "room-a" }],
        },
      },
    );
    const owner = h.toolFor("research");
    const other = h.toolFor("main");
    h.service.start();
    try {
      const {
        session: { sessionId },
      } = await entered.promise;
      expect(start).toHaveBeenCalledOnce();
      await expect(h.store.readSession(sessionId)).resolves.toMatchObject({
        metadata: { agentId: "research" },
        source: { agentId: "research", accountId: "account-a" },
      });
      const result = await owner.execute("status", { action: "status" });
      expect(result).toMatchObject({
        content: [{ type: "text", text: expect.stringContaining(sessionId) }],
        details: { active: [expect.objectContaining({ sessionId })] },
      });
      for (const identity of ["room-audio", "account-a", "guild-a", "room-a"]) {
        expect(result.content).toEqual([{ type: "text", text: expect.stringContaining(identity) }]);
      }
      await expect(other.execute("status", { action: "status" })).resolves.toMatchObject({
        content: [{ type: "text", text: expect.not.stringContaining(sessionId) }],
        details: { active: [] },
      });
      await expect(
        owner.execute("summary", { action: "summarize", sessionId }),
      ).resolves.toMatchObject({ details: { sessionId } });
    } finally {
      await h.service.stop();
    }
  });

  it("rejects configured auto-start when provider resolution removes the account", async () => {
    const start = vi.fn(startCapture);
    const h = harness({
      start,
      accessControl: {
        channelId: "discord",
        resolveAccountId: () => ({ ok: true, value: undefined }),
        authorize: async ({ caller, source }) =>
          caller.kind === "operator" ||
          (caller.channel === "discord" && caller.accountId === source.accountId)
            ? { ok: true, value: undefined }
            : { ok: false, error: "account denied" },
      },
    });
    await expect(
      startTranscripts({
        ctx: h,
        store: h.store,
        rawParams: { providerId: h.provider.id, accountId: "caller-account", sessionId: "notes" },
        configuredLifecycle: true,
      }),
    ).rejects.toThrow(
      "transcripts provider proof-live could not resolve an account for configured auto-start",
    );
    expect(start).not.toHaveBeenCalled();
    await expect(h.store.readSession("notes")).resolves.toBeUndefined();
  });

  it("keeps a session reserved while an overlapping stop is in flight", async () => {
    const entered = createDeferred();
    const release = createDeferred<{ ok: true; sessionId: string }>();
    const stop = vi.fn<Stop>(async () => {
      entered.resolve();
      return release.promise;
    });
    const h = harness({ stop });
    await h.start();
    const pending = h.execute("stop", "notes");
    await entered.promise;
    try {
      await expect(h.execute("stop", "notes")).resolves.toMatchObject({
        details: { sessionId: "notes", skipped: true },
      });
      expect(stop).toHaveBeenCalledOnce();
      await expect(h.start()).rejects.toThrow("transcripts session already active: notes");
    } finally {
      release.resolve({ ok: true, sessionId: "notes" });
      await pending;
    }
    const replacement = harness();
    await replacement.start();
    await expect(replacement.execute("status")).resolves.toMatchObject({
      details: { active: [expect.objectContaining({ sessionId: "notes" })] },
    });
    await replacement.execute("stop", "notes");
  });

  it.each([
    { limit: "entry count", idChars: 24, count: 8, shown: 5 },
    { limit: "oversized source locator", idChars: 2_200, count: 1, shown: 1 },
  ])(
    "bounds status by $limit without clipping canonical selectors",
    async ({ idChars, count, shown }) => {
      const provider: TranscriptSourceProvider = {
        id: "room-audio",
        name: "Room Audio",
        sourceKinds: ["live-audio"],
        start: async (request) => ({ ok: true, session: request.session }),
        stop: async (request) => ({ ok: true, sessionId: request.sessionId }),
      };
      registerTranscriptTestProvider(provider);
      const tool = createTranscriptsTool({
        stateDir: testState().stateDir,
        caller: { kind: "operator", source: "local" },
      });
      const sessionIds = [
        ...Array.from({ length: count }, (_, index) => `notes-${index}-${"?".repeat(idChars)}`),
        "readable-tail",
      ];
      const startedSessionIds: string[] = [];
      const selectors: string[] = [];
      try {
        for (const sessionId of sessionIds) {
          const result = await tool.execute("budget-start", {
            action: "start",
            providerId: "room-audio",
            sessionId,
            title: "Long meeting title\n".repeat(100),
            channelId: sessionId === "readable-tail" ? "room-a" : "r".repeat(idChars),
          });
          startedSessionIds.push(sessionId);
          const text = result.content.find((item) => item.type === "text")?.text ?? "";
          const selector = text.match(/\nSelector: (.+)$/)?.[1];
          if (typeof selector !== "string") {
            throw new Error("Start must return a canonical selector");
          }
          selectors.push(selector);
        }
        const result = await tool.execute("budget-status", { action: "status" });
        const text = result.content.find((item) => item.type === "text")?.text ?? "";
        const listing = text.split("\n").slice(2).join("\n");
        const rows = listing.split("\n").filter((line) => line.startsWith("{"));
        expect(listing.length).toBeLessThanOrEqual(2_000);
        expect(rows).toHaveLength(shown);
        expect(listing).toContain("active sessions omitted (display limit)");
        for (const row of rows) {
          expect(selectors).toContain(JSON.parse(row).selector);
        }
        if (idChars > 24) {
          expect(rows.some((row) => JSON.parse(row).selector === selectors.at(-1))).toBe(true);
        }
        expect(result.details).toMatchObject({
          active: sessionIds.map((sessionId) => expect.objectContaining({ sessionId })),
        });
      } finally {
        for (const sessionId of startedSessionIds) {
          await tool.execute("budget-stop", { action: "stop", sessionId });
        }
      }
    },
  );
});
