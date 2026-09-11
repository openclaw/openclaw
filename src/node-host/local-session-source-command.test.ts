import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import type { OpenClawPluginNodeHostCommandIo } from "../plugins/types.node-host.js";
import {
  decodeLocalSessionSourceFrame,
  encodeLocalSessionFrame,
  type LocalSessionGatewayFrame,
  type LocalSessionSourceFrame,
} from "../sessions/local-session-source-protocol.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { configureNodeHost } from "./config.js";
import {
  decideLocalSessionOffer,
  recordLocalSessionOffer,
  recordLocalSessionPreconsent,
  readLocalSessionConsentState,
} from "./local-session-consent-store.js";
import {
  createLocalSessionSourceNodeCommand,
  type LocalSessionSourceDefinition,
  type LocalSessionSourceSession,
} from "./local-session-source-command.js";

const enrollment = {
  enrollmentId: "enroll-1",
  agentId: "main",
  requester: { profileId: "profile-alice", displayName: "Alice" },
  audienceLabel: "everyone with write access",
};

function createFakeIo() {
  const sent: LocalSessionSourceFrame[] = [];
  const controller = new AbortController();
  let receiver: ((message: Uint8Array) => void | Promise<void>) | undefined;
  const io: OpenClawPluginNodeHostCommandIo = {
    emitChunk: async () => {},
    onInput: () => {},
    frames: {
      send: async (message) => {
        sent.push(decodeLocalSessionSourceFrame(message));
      },
      onMessage: (listener) => {
        receiver = listener;
        return () => {
          receiver = undefined;
        };
      },
    },
    signal: controller.signal,
  };
  const deliver = async (frame: LocalSessionGatewayFrame) => {
    await receiver?.(encodeLocalSessionFrame(frame));
  };
  const deliverRaw = async (bytes: Uint8Array) => {
    await receiver?.(bytes);
  };
  return { io, sent, deliver, deliverRaw, close: () => controller.abort() };
}

async function flush() {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 20);
  });
}

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

afterAll(() => {
  cleanupTempDirs(tempDirs);
});

describe("local session source node command", () => {
  it("announces itself, records offers, delivers the local decision, then starts the source", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", makeTempDir(tempDirs, "local-session-source-"));
    const started: Array<Record<string, number>> = [];
    let session: LocalSessionSourceSession | undefined;
    const definition: LocalSessionSourceDefinition = {
      id: "codex",
      label: "Codex",
      command: "codex.localSessions.source.v1",
      inputModes: ["steer", "followup"],
      start: async (host, options) => {
        started.push({ ...options.cursors });
        await host.publishSession({ threadId: "t1", state: "idle", canInput: true });
        session = {
          submitInput: async (input) => {
            await host.reportInput({
              inputId: input.inputId,
              threadId: input.threadId,
              outcome: "committed",
              nativeRef: "turn-1",
            });
          },
          unshare: () => {},
          stop: async () => {},
        };
        return session;
      },
    };
    const command = createLocalSessionSourceNodeCommand(definition);
    expect(command.localSessionSource).toEqual({ sourceId: "codex", label: "Codex" });
    const fake = createFakeIo();
    const done = command.handle(null, fake.io);
    await flush();
    expect(fake.sent[0]).toMatchObject({ type: "hello", sourceId: "codex" });

    await fake.deliver({ type: "offer", enrollment });
    expect(
      readLocalSessionConsentState().offers.map((offer) => offer.enrollment.enrollmentId),
    ).toEqual(["enroll-1"]);
    // The person answers from a separate CLI process; the runtime polls the shared store.
    decideLocalSessionOffer({ enrollmentId: "enroll-1", decision: "accepted" });
    await vi.waitFor(() => expect(fake.sent.some((frame) => frame.type === "consent")).toBe(true), {
      timeout: 5000,
    });
    expect(readLocalSessionConsentState().consents[0]?.deliveredAtMs).toBeTypeOf("number");

    await fake.deliver({ type: "resume", enrollment, cursors: { t1: 4 }, excludedThreadIds: [] });
    expect(started).toEqual([{ t1: 4 }]);
    expect(fake.sent.map((frame) => frame.type)).toEqual(["hello", "consent", "session"]);

    await fake.deliver({
      type: "input",
      inputId: "in-1",
      threadId: "t1",
      mode: "steer",
      text: "hello",
      sender: { displayName: "Alice" },
    });
    expect(fake.sent.at(-1)).toMatchObject({
      type: "inputResult",
      inputId: "in-1",
      outcome: "committed",
    });

    fake.close();
    await expect(done).resolves.toContain('"ok":true');
  });

  it("accepts an offer covered by connect --share and runs the source enablement", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", makeTempDir(tempDirs, "local-session-source-"));
    // The connect command paired this node with the Gateway that will offer.
    await configureNodeHost({
      fallbackDisplayName: "test-node",
      gateway: { host: "gw.test", port: 18789, contextPath: "" },
    });
    recordLocalSessionPreconsent({
      sourceId: "codex",
      gateway: { host: "gw.test", port: 18789, contextPath: "" },
      setupId: "setup-1",
    });
    let enabled = 0;
    let started = 0;
    const command = createLocalSessionSourceNodeCommand({
      id: "codex",
      command: "codex.localSessions.source.v1",
      inputModes: ["steer"],
      enableSharing: async () => {
        enabled += 1;
        return ["installed"];
      },
      start: async () => {
        started += 1;
        return { submitInput: async () => {}, unshare: () => {}, stop: async () => {} };
      },
    });
    const fake = createFakeIo();
    const done = command.handle(null, fake.io);
    await flush();
    // An offer for someone else's request (another setup) still prompts.
    await fake.deliver({
      type: "offer",
      enrollment: { ...enrollment, enrollmentId: "enroll-other", setupId: "setup-9" },
    });
    await fake.deliver({ type: "offer", enrollment: { ...enrollment, setupId: "setup-1" } });
    // Only the minted request was accepted; the other offer still waits for a person.
    expect(
      readLocalSessionConsentState().offers.map((offer) => offer.enrollment.enrollmentId),
    ).toEqual(["enroll-other"]);
    expect(readLocalSessionConsentState().preconsents).toEqual([]);
    expect(enabled).toBe(1);
    await vi.waitFor(
      () =>
        expect(
          fake.sent.some((frame) => frame.type === "consent" && frame.decision === "accepted"),
        ).toBe(true),
      { timeout: 5000 },
    );
    await fake.deliver({ type: "resume", enrollment, cursors: {}, excludedThreadIds: [] });
    expect(started).toBe(1);
    // A second offer for the same source is a normal prompt again.
    await fake.deliver({
      type: "offer",
      enrollment: { ...enrollment, enrollmentId: "enroll-2", setupId: "setup-1" },
    });
    expect(
      readLocalSessionConsentState().offers.map((offer) => offer.enrollment.enrollmentId),
    ).toEqual(["enroll-other", "enroll-2"]);
    fake.close();
    await done;
  });

  it("starts a reopened channel's session only after the previous session stopped", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", makeTempDir(tempDirs, "local-session-source-"));
    const order: string[] = [];
    const definition: LocalSessionSourceDefinition = {
      id: "codex",
      command: "codex.localSessions.source.v1",
      inputModes: ["steer"],
      start: async () => {
        order.push("start");
        return {
          submitInput: async () => {},
          unshare: () => {},
          stop: async () => {
            // A socket server takes a moment to release its address.
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 150);
            });
            order.push("stop");
          },
        };
      },
    };
    recordLocalSessionOffer({ sourceId: "codex", enrollment });
    decideLocalSessionOffer({ enrollmentId: "enroll-1", decision: "accepted" });
    const command = createLocalSessionSourceNodeCommand(definition);
    const first = createFakeIo();
    const firstDone = command.handle(null, first.io);
    await flush();
    await first.deliver({ type: "resume", enrollment, cursors: {}, excludedThreadIds: [] });
    // The Gateway drops the duplex and opens a new one right away.
    first.close();
    const second = createFakeIo();
    const secondDone = command.handle(null, second.io);
    await flush();
    await second.deliver({ type: "resume", enrollment, cursors: {}, excludedThreadIds: [] });
    expect(order).toEqual(["start", "stop", "start"]);
    await firstDone;
    second.close();
    await secondDone;
  });

  it("drops an invalid Gateway frame without stopping the source", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", makeTempDir(tempDirs, "local-session-source-"));
    const command = createLocalSessionSourceNodeCommand({
      id: "codex",
      command: "codex.localSessions.source.v1",
      inputModes: ["steer"],
      start: async () => ({ submitInput: async () => {}, unshare: () => {}, stop: async () => {} }),
    });
    const fake = createFakeIo();
    const done = command.handle(null, fake.io);
    await flush();
    await fake.deliverRaw(new TextEncoder().encode(JSON.stringify({ type: "bogus" })));
    await fake.deliverRaw(new TextEncoder().encode("not json"));
    // The channel is still up: a valid frame after the bad ones gets its usual outcome.
    await fake.deliver({
      type: "input",
      inputId: "in-2",
      threadId: "t2",
      mode: "steer",
      text: "hello",
      sender: { displayName: "Alice" },
    });
    expect(fake.sent.at(-1)).toMatchObject({ type: "inputResult", inputId: "in-2" });
    fake.close();
    await expect(done).resolves.toContain('"ok":true');
  });

  it("refuses a resume the person never accepted locally", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", makeTempDir(tempDirs, "local-session-source-"));
    let starts = 0;
    const command = createLocalSessionSourceNodeCommand({
      id: "codex",
      command: "codex.localSessions.source.v1",
      inputModes: ["steer"],
      start: async () => {
        starts += 1;
        return { submitInput: async () => {}, unshare: () => {}, stop: async () => {} };
      },
    });
    const fake = createFakeIo();
    const done = command.handle(null, fake.io);
    await flush();
    // An offer that was never answered, and one that was declined, must not publish.
    await fake.deliver({ type: "offer", enrollment });
    await fake.deliver({ type: "resume", enrollment, cursors: {}, excludedThreadIds: [] });
    decideLocalSessionOffer({ enrollmentId: "enroll-1", decision: "declined" });
    await fake.deliver({ type: "resume", enrollment, cursors: {}, excludedThreadIds: [] });
    expect(starts).toBe(0);
    expect(fake.sent.filter((frame) => frame.type === "session")).toEqual([]);
    fake.close();
    await done;
  });

  it("rejects input before a source session exists instead of dropping it", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", makeTempDir(tempDirs, "local-session-source-"));
    const command = createLocalSessionSourceNodeCommand({
      id: "claude",
      command: "anthropic.claude.localSessions.source.v1",
      inputModes: ["followup"],
      start: async () => ({ submitInput: async () => {}, unshare: () => {}, stop: async () => {} }),
    });
    const fake = createFakeIo();
    const done = command.handle(null, fake.io);
    await flush();
    await fake.deliver({
      type: "input",
      inputId: "in-9",
      threadId: "t9",
      mode: "followup",
      text: "hello",
      sender: { displayName: "Alice" },
    });
    expect(fake.sent.at(-1)).toMatchObject({
      type: "inputResult",
      inputId: "in-9",
      outcome: "rejected",
    });
    fake.close();
    await done;
  });
});
