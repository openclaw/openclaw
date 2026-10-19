import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { TerminalBackend } from "./backend.js";
import { composeTerminalIntroBanner } from "./intro-banner.js";
import { TerminalSessionManager } from "./session-manager.js";
import {
  agentTerminalOwner,
  baseOpenRequest as baseRequest,
  expectTerminalOpen,
  type FakeTerminalPty,
  makeFakePty,
} from "./session-manager.test-helpers.js";
const managers: TerminalSessionManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) {
    manager.disposeAll();
  }
  vi.useRealTimers();
});

const TERMINAL_EVENT_DATA = "terminal.data";
const TERMINAL_EVENT_EXIT = "terminal.exit";
const OPERATOR_INTRO = composeTerminalIntroBanner();

function fixture(options: Partial<ConstructorParameters<typeof TerminalSessionManager>[0]> = {}) {
  const { emit: observe, ...settings } = options;
  const emit = vi.fn(observe);
  const fake = makeFakePty();
  const manager = new TerminalSessionManager({ emit, spawn: async () => fake, ...settings });
  managers.push(manager);
  return { emit, fake, manager };
}
function heldPty() {
  const fake = makeFakePty();
  const gate = createDeferred<FakeTerminalPty>();
  return { fake, spawn: () => gate.promise, release: () => gate.resolve(fake) };
}
const start = (manager: TerminalSessionManager, request?: Parameters<typeof baseRequest>[0]) =>
  manager.open(baseRequest(request));
async function open(manager: TerminalSessionManager, request?: Parameters<typeof baseRequest>[0]) {
  return expectTerminalOpen(await start(manager, request));
}

async function openSlowViewers() {
  const bufferedAmounts = new Map([
    ["viewer-slow", Number.MAX_SAFE_INTEGER],
    ["viewer-healthy", 0],
  ]);
  const setup = fixture({ getBufferedAmount: (connId) => bufferedAmounts.get(connId) });
  const { sessionId } = await open(setup.manager, { owner: agentTerminalOwner("agent:main:main") });
  setup.manager.attach("viewer-slow", sessionId);
  setup.manager.attach("viewer-healthy", sessionId);
  setup.fake.emitData("pressure");
  await vi.advanceTimersByTimeAsync(4);
  expect(setup.fake.paused).toBe(true);
  return { ...setup, sessionId };
}

describe("TerminalSessionManager", () => {
  it.each(["resize", "relay"] as const)(
    "finalizes and reports a %s backend error",
    async (source) => {
      const { emit, manager } = fixture();
      const kill = vi.fn(() => manager.size);
      let onExit: Parameters<TerminalBackend["onExit"]>[0] | undefined;
      const backend: TerminalBackend = {
        write: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
        onData: vi.fn(),
        kill,
        resize: () => {
          throw new Error("dead PTY");
        },
        onExit: (callback) => {
          onExit = callback;
        },
      };
      const { sessionId } = await open(manager, { createBackend: async () => backend });
      const error =
        source === "resize"
          ? "resize failed"
          : "ROUTE_CHANGED: node connection changed before dispatch";
      if (source === "resize") {
        expect(manager.resize("conn-1", sessionId, 120, 40)).toBe(false);
        expect(manager.size).toBe(0);
        expect(kill).toHaveBeenCalledOnce();
        expect(kill).toHaveReturnedWith(1);
      } else {
        onExit?.({ error });
      }
      expect(emit).toHaveBeenCalledWith("conn-1", TERMINAL_EVENT_EXIT, {
        sessionId,
        exitCode: null,
        signal: null,
        reason: "error",
        error,
      });
    },
  );

  it("coalesces thousands of PTY chunks into a bounded number of data frames", async () => {
    vi.useFakeTimers();
    const { emit, fake, manager } = fixture();
    await open(manager);
    await vi.advanceTimersByTimeAsync(4);
    emit.mockClear();

    const chunk = "12345678";
    for (let index = 0; index < 10_000; index += 1) {
      fake.emitData(chunk);
    }
    await vi.advanceTimersByTimeAsync(4);

    const frames = emit.mock.calls
      .filter(([, event]) => event === TERMINAL_EVENT_DATA)
      .map((call) => call[2] as { seq: number; data: string });
    expect(frames.length).toBeLessThan(10);
    expect(frames.map(({ seq }) => seq)).toEqual([
      OPERATOR_INTRO.length + 65_536,
      OPERATOR_INTRO.length + 80_000,
    ]);
    expect(frames.every(({ data }) => Buffer.byteLength(data, "utf8") <= 64 * 1024)).toBe(true);
    expect(frames.map(({ data }) => data).join("")).toBe(chunk.repeat(10_000));
  });

  it("flushes small output immediately after terminal input", async () => {
    const { emit, fake, manager } = fixture();
    const outcome = await open(manager);
    await vi.waitFor(() => expect(emit).toHaveBeenCalledOnce());
    emit.mockClear();

    expect(manager.write("conn-1", outcome.sessionId, "x")).toBe(true);
    fake.emitData("x");

    expect(emit).toHaveBeenCalledWith("conn-1", TERMINAL_EVENT_DATA, {
      sessionId: outcome.sessionId,
      seq: OPERATOR_INTRO.length + 1,
      data: "x",
    });
  });

  it.each(["connection", "viewer"] as const)(
    "stages uploads only for an authorized %s",
    async (kind) => {
      const stageUpload = vi.fn(async () => ({ path: "/tmp/node/report.pdf", size: 4 }));
      const { manager } = fixture();
      const viewer = kind === "viewer";
      const { sessionId } = await open(manager, {
        stageUpload,
        ...(viewer ? { owner: agentTerminalOwner("agent:main:main") } : {}),
      });
      const file = { name: "report.pdf", contentBase64: "dGVzdA==" };
      await expect(manager.upload("stranger", sessionId, file)).resolves.toBeUndefined();
      expect(stageUpload).not.toHaveBeenCalled();
      if (viewer) {
        expect(manager.attach("viewer-1", sessionId)?.sessionId).toBe(sessionId);
      }
      await expect(
        manager.upload(viewer ? "viewer-1" : "conn-1", sessionId, file),
      ).resolves.toEqual({
        path: "/tmp/node/report.pdf",
        size: 4,
      });
      expect(stageUpload).toHaveBeenCalledWith(file);
    },
  );

  it("emits an exit event and drops the session when the process exits", async () => {
    const { emit, fake, manager } = fixture();
    const outcome = await open(manager);

    fake.emitExit(0);
    expect(manager.size).toBe(0);
    expect(emit).toHaveBeenCalledWith("conn-1", TERMINAL_EVENT_EXIT, {
      sessionId: outcome.sessionId,
      exitCode: 0,
      signal: null,
      reason: "process_exit",
    });
    expect(fake.killed).toBe(true);
  });

  it("closes live and pending sessions when their agent becomes disallowed", async () => {
    const pending = heldPty();
    const { emit, fake: livePty, manager } = fixture();

    const live = await start(manager, { agentId: "locked" });
    expect(live.ok).toBe(true);
    const opening = start(manager, {
      agentId: "locked",
      owner: { kind: "conn", connId: "conn-2" },
      createBackend: pending.spawn,
    });

    manager.closeDisallowedAgents((agentId) => agentId !== "locked");
    expect(livePty.killed).toBe(true);
    expect(manager.size).toBe(0);
    expect(emit).toHaveBeenCalledWith(
      "conn-1",
      TERMINAL_EVENT_EXIT,
      expect.objectContaining({ reason: "closed" }),
    );

    pending.release();
    expect((await opening).ok).toBe(false);
    expect(pending.fake.killed).toBe(true);
    expect(manager.size).toBe(0);
  });

  it.each([
    ["owner", { owner: { kind: "conn" as const, connId: "conn-x" } }],
    [
      "initial viewer",
      {
        owner: agentTerminalOwner("agent:main:ui-session", "ui-session-id"),
        viewerConnId: "conn-x",
      },
    ],
  ] as const)("kills pending opens on %s disconnect", async (_, request) => {
    const { fake, spawn, release } = heldPty();
    const { manager } = fixture({ spawn });
    const openPromise = start(manager, request);

    manager.handleDisconnect("conn-x");
    release();
    const outcome = await openPromise;
    expect(outcome).toMatchObject({ ok: false, code: "closed" });

    expect(fake.killed).toBe(true);
    expect(manager.size).toBe(0);
  });

  it("enforces the cap against concurrent opens racing on the async spawn", async () => {
    const { spawn, release } = heldPty();
    const { manager } = fixture({ spawn, maxSessions: 1 });
    const both = Promise.all([start(manager), start(manager)]);
    release();
    const [a, b] = await both;

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(manager.size).toBe(1);
  });
});

describe("TerminalSessionManager agent ownership", () => {
  const agentOwner = agentTerminalOwner("agent:main:main");

  it.each([
    ["none", "close", false],
    ["none", "disconnect", false],
    ["resize", "close", true],
    ["resize", "disconnect", true],
    ["agent read", "close", true],
    ["attach", "close", true],
  ] as const)(
    "%s adoption then %s leaves the UI-created shared terminal alive=%s",
    async (adoption, removal, survives) => {
      const { fake, manager } = fixture({ maxSessions: 1 });
      const outcome = await open(manager, { owner: agentOwner, viewerConnId: "viewer-1" });

      expect(manager.close("stranger", outcome.sessionId)).toBe(false);
      if (adoption === "resize") {
        manager.resize("viewer-1", outcome.sessionId, 120, 40);
      } else if (adoption === "agent read") {
        manager.snapshotAgent(agentOwner, outcome.sessionId);
      } else if (adoption === "attach") {
        manager.attach("viewer-2", outcome.sessionId);
      }
      if (removal === "close") {
        expect(manager.close("viewer-1", outcome.sessionId)).toBe(true);
      } else {
        manager.handleDisconnect("viewer-1");
      }
      expect([manager.size, fake.killed]).toEqual([survives ? 1 : 0, !survives]);
      if (!survives && removal === "close") {
        expect((await start(manager)).ok).toBe(true);
      }
    },
  );

  it("continues UTF-16 offsets after output buffered before the first viewer", async () => {
    vi.useFakeTimers();
    const { emit, fake, manager } = fixture();
    const outcome = await open(manager, { owner: agentOwner });

    fake.emitData("😀");
    await vi.advanceTimersByTimeAsync(4);
    const attached = manager.attach("viewer-1", outcome.sessionId);
    expect(attached).toMatchObject({
      buffer: "😀",
      seq: 2,
      owner: `agent:${agentOwner.agentSessionKey}`,
    });

    fake.emitData("after");
    await vi.advanceTimersByTimeAsync(4);
    expect(emit).toHaveBeenCalledWith("viewer-1", TERMINAL_EVENT_DATA, {
      sessionId: outcome.sessionId,
      seq: 7,
      data: "after",
    });
  });

  it("co-attaches viewers without take-over and cleans each viewer independently", async () => {
    vi.useFakeTimers();
    const { emit, fake, manager } = fixture({
      // Disconnect during fanout must not prevent delivery to the next viewer.
      emit: (connId, event) => {
        if (connId === "viewer-1" && event === TERMINAL_EVENT_DATA) {
          manager.handleDisconnect(connId);
        }
      },
    });
    const outcome = await open(manager, { owner: agentOwner });

    expect(manager.attach("viewer-1", outcome.sessionId)).toBeDefined();
    expect(manager.attach("viewer-2", outcome.sessionId)).toBeDefined();
    expect(manager.attach("viewer-1", outcome.sessionId)).toBeDefined();
    expect(emit).not.toHaveBeenCalledWith(
      "viewer-1",
      TERMINAL_EVENT_EXIT,
      expect.objectContaining({ reason: "detached" }),
    );

    fake.emitData("both");
    await vi.advanceTimersByTimeAsync(4);
    const dataRecipients = emit.mock.calls
      .filter(([, event]) => event === TERMINAL_EVENT_DATA)
      .map(([connId]) => connId);
    expect(dataRecipients).toEqual(["viewer-1", "viewer-2"]);

    emit.mockClear();
    fake.emitData("one");
    await vi.advanceTimersByTimeAsync(4);
    expect(emit).toHaveBeenCalledWith(
      "viewer-2",
      TERMINAL_EVENT_DATA,
      expect.objectContaining({ data: "one" }),
    );
    expect(emit).not.toHaveBeenCalledWith("viewer-1", TERMINAL_EVENT_DATA, expect.anything());

    expect(manager.close("viewer-2", outcome.sessionId)).toBe(true);
    expect(manager.size).toBe(1);
    expect(fake.killed).toBe(false);
    expect(manager.list()).toMatchObject([
      { sessionId: outcome.sessionId, attached: false, owner: "agent:agent:main:main" },
    ]);
    expect(manager.close("stranger", outcome.sessionId)).toBe(false);
    expect(manager.attach("viewer-2", outcome.sessionId)).toBeDefined();
    expect(manager.closeAgent(agentOwner, outcome.sessionId)).toEqual({ ok: true });
    expect(manager.size).toBe(0);
    expect(fake.killed).toBe(true);
  });

  it.each(["disconnect slow", "close slow", "disconnect healthy"] as const)(
    "reconciles shared-terminal backpressure after %s",
    async (removal) => {
      vi.useFakeTimers();
      const { fake, emit, manager, sessionId } = await openSlowViewers();
      if (removal === "close slow") {
        expect(manager.close("viewer-slow", sessionId)).toBe(true);
      } else {
        manager.handleDisconnect(removal === "disconnect slow" ? "viewer-slow" : "viewer-healthy");
      }
      if (removal === "disconnect healthy") {
        expect(fake).toMatchObject({ paused: true, resumeCalls: 0 });
      } else {
        expect(fake.paused).toBe(false);
        emit.mockClear();
        fake.emitData("resumed");
        await vi.advanceTimersByTimeAsync(4);
        expect(emit).toHaveBeenCalledWith(
          "viewer-healthy",
          TERMINAL_EVENT_DATA,
          expect.objectContaining({ data: "resumed" }),
        );
        expect(emit).not.toHaveBeenCalledWith(
          "viewer-slow",
          TERMINAL_EVENT_DATA,
          expect.anything(),
        );
      }
    },
  );
});

describe("TerminalSessionManager agent session lifecycle", () => {
  it.each(["previous cancellation", "output flush"] as const)(
    "stops cancelling terminals when drain authority is revoked by %s",
    async (revocation) => {
      vi.useFakeTimers();
      const owner = agentTerminalOwner("agent:main:archive-target");
      const firstPty = makeFakePty();
      const secondPty = makeFakePty();
      const pendingPty = makeFakePty();
      const pendingBackend = createDeferred<FakeTerminalPty>();
      let current = true;
      let bufferedAmount = Number.MAX_SAFE_INTEGER;
      const killFirst = firstPty.kill.bind(firstPty);
      firstPty.kill = () => {
        killFirst();
        current = false;
      };
      const { emit, manager } = fixture({
        emit: (_connId, event) => {
          if (revocation === "output flush" && event === TERMINAL_EVENT_DATA) {
            current = false;
          }
        },
        getBufferedAmount: revocation === "output flush" ? () => bufferedAmount : undefined,
        spawn: async () => makeFakePty(),
      });
      let drain: ReturnType<TerminalSessionManager["beginAgentSessionDrain"]> | undefined;
      let opening: ReturnType<TerminalSessionManager["open"]> | undefined;
      try {
        const first = await open(manager, {
          owner,
          viewerConnId: "viewer",
          createBackend: async () => firstPty,
        });
        const second = await open(manager, { owner, createBackend: async () => secondPty });
        const beginDrain = () =>
          manager.beginAgentSessionDrain(owner, () => {
            if (!current) {
              throw new Error("deletion superseded");
            }
          });
        if (revocation === "output flush") {
          expect(beginDrain).toThrow("deletion superseded");
          expect(firstPty.paused).toBe(true);
        } else {
          opening = start(manager, { owner, createBackend: () => pendingBackend.promise });
          drain = beginDrain();
          const settled = vi.fn((error?: unknown) => error);
          const outcome = drain.drained.then(() => settled(), settled);
          await Promise.resolve();
          expect(settled).not.toHaveBeenCalled();
          expect(drain.hasWork()).toBe(true);
          firstPty.emitExit(0);
          await Promise.resolve();
          expect(settled).not.toHaveBeenCalled();
          pendingBackend.resolve(pendingPty);
          await expect(opening).resolves.toMatchObject({ ok: false, code: "closed" });
          expect(pendingPty.killed).toBe(true);
          expect(settled).not.toHaveBeenCalled();
          pendingPty.emitExit(0);
          expect(await outcome).toEqual(new Error("deletion superseded"));
          expect(drain.hasWork()).toBe(false);
          drain.release();
        }
        expect(firstPty.killed).toBe(revocation === "previous cancellation");
        expect(secondPty.killed).toBe(false);
        const survivor = revocation === "output flush" ? first : second;
        const survivorPty = revocation === "output flush" ? firstPty : secondPty;
        expect(manager.writeAgent(owner, survivor.sessionId, "still active")).toEqual({ ok: true });
        expect(survivorPty.writes).toEqual(["still active"]);
        if (revocation === "output flush") {
          bufferedAmount = 0;
          await vi.advanceTimersByTimeAsync(5_000);
          expect(survivorPty.paused).toBe(false);
          emit.mockClear();
          survivorPty.emitData("still streaming");
          await vi.advanceTimersByTimeAsync(4);
          expect(emit).toHaveBeenCalledWith(
            "viewer",
            TERMINAL_EVENT_DATA,
            expect.objectContaining({ sessionId: survivor.sessionId, data: "still streaming" }),
          );
        }
        await expect(start(manager, { owner })).resolves.toMatchObject({ ok: true });
      } finally {
        pendingBackend.resolve(pendingPty);
        await opening;
        firstPty.emitExit(0);
        pendingPty.emitExit(0);
        await drain?.drained.catch(() => {});
        drain?.release();
      }
    },
  );

  it("keeps terminal admission fenced until every overlapping drain releases", async () => {
    const { manager } = fixture();
    const owner = agentTerminalOwner("agent:main:archive-target");
    const first = manager.beginAgentSessionDrain(owner);
    const second = manager.beginAgentSessionDrain(owner);
    try {
      await Promise.all([first.drained, second.drained]);
      first.release();
      first.release();
      await expect(start(manager, { owner })).resolves.toMatchObject({ ok: false, code: "closed" });
      second.release();
      await expect(start(manager, { owner })).resolves.toMatchObject({ ok: true });
    } finally {
      first.release();
      second.release();
    }
  });

  it("drains one agent incarnation while admitting its same-key replacement", async () => {
    const oldPty = makeFakePty();
    const pendingPty = makeFakePty();
    const { promise: pendingBackend, resolve: resolvePending } =
      createDeferred<ReturnType<typeof makeFakePty>>();
    const { manager } = fixture({ spawn: async () => makeFakePty() });
    const oldOwner = agentTerminalOwner("agent:main:archive-target", "old-session");
    const replacementOwner = agentTerminalOwner("agent:main:archive-target", "replacement-session");
    await open(manager, { owner: oldOwner, createBackend: async () => oldPty });
    const pending = start(manager, { owner: oldOwner, createBackend: () => pendingBackend });

    const drain = manager.beginAgentSessionDrain(oldOwner);
    expect(oldPty.killed).toBe(true);
    expect(drain.hasWork()).toBe(true);
    resolvePending(pendingPty);
    await expect(pending).resolves.toMatchObject({ ok: false, code: "closed" });
    expect(pendingPty.killed).toBe(true);
    expect(drain.hasWork()).toBe(true);
    oldPty.emitExit(0);
    expect(drain.hasWork()).toBe(true);
    pendingPty.emitExit(0);
    await expect(drain.drained).resolves.toBeUndefined();
    expect(drain.hasWork()).toBe(false);
    await expect(start(manager, { owner: oldOwner })).resolves.toMatchObject({
      ok: false,
      code: "closed",
    });
    await open(manager, { owner: replacementOwner });

    drain.release();
    await open(manager, { owner: oldOwner });
  });
});

describe("TerminalSessionManager open cancellation", () => {
  it("kills a backend that finishes after its open request is cancelled", async () => {
    const first = heldPty();
    const second = makeFakePty();
    const controller = new AbortController();
    const spawn = vi.fn(first.spawn).mockImplementationOnce(first.spawn).mockResolvedValue(second);
    const { manager } = fixture({ maxSessions: 1, spawn });
    const opening = start(manager, { signal: controller.signal });

    controller.abort(new Error("terminal open timed out"));
    const next = await open(manager, { owner: { kind: "conn", connId: "conn-2" } });
    first.release();

    await expect(opening).resolves.toEqual({
      ok: false,
      code: "closed",
      message: "terminal open timed out",
    });
    expect(first.fake.killed).toBe(true);
    expect(manager.size).toBe(1);
    expect(manager.close("conn-2", next.sessionId)).toBe(true);
    expect(second.killed).toBe(true);
    expect(manager.size).toBe(0);
  });

  it("bounds cancelled backend operations until they settle", async () => {
    const first = heldPty();
    const second = heldPty();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const spawn = vi.fn(second.spawn).mockImplementationOnce(first.spawn);
    const { manager } = fixture({ maxSessions: 1, spawn });

    const firstOpening = start(manager, { signal: firstController.signal });
    firstController.abort(new Error("first cancelled"));
    const secondOpening = start(manager, {
      owner: { kind: "conn", connId: "conn-2" },
      signal: secondController.signal,
    });
    secondController.abort(new Error("second cancelled"));

    await expect(start(manager, { owner: { kind: "conn", connId: "conn-3" } })).resolves.toEqual({
      ok: false,
      code: "limit",
      message: "terminal spawn limit reached (2)",
    });

    first.release();
    second.release();
    await expect(firstOpening).resolves.toMatchObject({ ok: false, code: "closed" });
    await expect(secondOpening).resolves.toMatchObject({ ok: false, code: "closed" });
    expect([first.fake, second.fake]).toMatchObject([{ killed: true }, { killed: true }]);
  });
});

describe("TerminalSessionManager output ring", () => {
  it("bounds buffered output by evicting whole head chunks", async () => {
    const { fake, manager } = fixture({ scrollbackChars: 8 });
    const outcome = await open(manager);
    fake.emitData("abcd");
    fake.emitData("efgh");
    expect(manager.snapshot(outcome.sessionId)).toBe("abcdefgh");
    fake.emitData("ijkl");

    expect(manager.snapshot(outcome.sessionId)).toBe("efghijkl");

    for (let value = 0; value < 5_000; value += 1) {
      fake.emitData(String(value).padStart(4, "0"));
    }
    expect(manager.snapshot(outcome.sessionId)).toBe("49984999");
    expect(manager.attach("conn-2", outcome.sessionId)?.buffer).toBe("49984999");
    fake.emitData("tail");
    expect(manager.snapshot(outcome.sessionId)).toBe("4999tail");
  });

  it("does not retain a leading lone low surrogate from an oversized chunk", async () => {
    const { fake, manager } = fixture({ scrollbackChars: 3 });
    const outcome = await open(manager);

    fake.emitData("ab😀cd");

    expect(manager.snapshot(outcome.sessionId)).toBe("cd");
  });
});
