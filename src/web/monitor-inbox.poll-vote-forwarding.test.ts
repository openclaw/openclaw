import { vi } from "vitest";

// ---------- mocks ----------
vi.mock("../media/store.js", () => ({
  saveMediaBuffer: vi
    .fn()
    .mockResolvedValue({ id: "mid", path: "/tmp/mid", size: 1, contentType: "image/jpeg" }),
}));

const mockLoadConfig = vi.fn().mockReturnValue({
  channels: { whatsapp: { allowFrom: ["*"] } },
  messages: { messagePrefix: undefined, responsePrefix: undefined },
});
vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return { ...actual, loadConfig: () => mockLoadConfig() };
});

vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
  upsertChannelPairingRequest: vi.fn().mockResolvedValue({ code: "PAIRCODE", created: true }),
}));

// Fake poll store & vote helpers – we control the return values per test.
const getPollMock = vi.fn();
const decryptPollVoteMock = vi.fn();
const matchPollOptionsMock = vi.fn();

vi.mock("./inbound/poll-store.js", () => ({
  getPoll: (...args: unknown[]) => getPollMock(...args),
  storePoll: vi.fn(),
}));
vi.mock("./inbound/poll-vote.js", () => ({
  decryptPollVote: (...args: unknown[]) => decryptPollVoteMock(...args),
  matchPollOptions: (...args: unknown[]) => matchPollOptionsMock(...args),
}));

vi.mock("./session.js", () => {
  const { EventEmitter } = require("node:events");
  const ev = new EventEmitter();
  const sock = {
    ev,
    ws: { close: vi.fn() },
    sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    readMessages: vi.fn().mockResolvedValue(undefined),
    updateMediaMessage: vi.fn(),
    logger: {},
    signalRepository: { lidMapping: { getPNForLID: vi.fn().mockResolvedValue(null) } },
    user: { id: "123@s.whatsapp.net" },
  };
  return {
    createWaSocket: vi.fn().mockResolvedValue(sock),
    waitForWaConnection: vi.fn().mockResolvedValue(undefined),
    getStatusCode: vi.fn(() => 500),
  };
});

// ---------- imports (after mocks) ----------
const { createWaSocket } = await import("./session.js");
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { monitorWebInbox, resetWebInboundDedupe } from "./inbound.js";

// ---------- helpers ----------
function pollUpsert(opts: {
  msgId?: string;
  remoteJid?: string;
  creationMsgKeyId?: string;
  encPayload?: Uint8Array;
  encIv?: Uint8Array;
}) {
  return {
    type: "notify",
    messages: [
      {
        key: {
          id: opts.msgId ?? "vote-1",
          fromMe: false,
          remoteJid: opts.remoteJid ?? "555@s.whatsapp.net",
        },
        message: {
          pollUpdateMessage: {
            pollCreationMessageKey: {
              id: opts.creationMsgKeyId ?? "poll-abc",
              remoteJid: opts.remoteJid ?? "555@s.whatsapp.net",
            },
            vote: {
              encPayload: opts.encPayload ?? Buffer.from("fakepayload"),
              encIv: opts.encIv ?? Buffer.from("fakeiv123456"),
            },
            senderTimestampMs: 1_700_000_000_000,
          },
        },
        messageTimestamp: 1_700_000_100,
        pushName: "Voter",
      },
    ],
  };
}

const STORED_POLL = {
  pollMsgId: "poll-abc",
  messageSecret: Buffer.from("s".repeat(32)).toString("base64"),
  options: ["Buy milk", "Buy eggs", "Buy bread"],
  question: "What to buy?",
  chatJid: "555@s.whatsapp.net",
  createdAt: Date.now(),
};

// ---------- suite ----------
describe("poll vote forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWebInboundDedupe();
    // Default: poll found, decrypt succeeds, one option selected
    getPollMock.mockReturnValue(STORED_POLL);
    decryptPollVoteMock.mockReturnValue({
      selectedOptions: [Buffer.from("Buy milk")], // raw bytes; matchPollOptions resolves names
    });
    matchPollOptionsMock.mockReturnValue(["Buy milk"]);
  });

  it("forwards a decrypted poll vote with structured pollVote payload", async () => {
    const onMessage = vi.fn();
    const listener = await monitorWebInbox({ verbose: false, onMessage });
    const sock = await createWaSocket();

    sock.ev.emit("messages.upsert", pollUpsert({}));
    await new Promise((resolve) => setImmediate(resolve));

    expect(onMessage).toHaveBeenCalledTimes(1);
    const msg = onMessage.mock.calls[0][0];

    // Text body is the human-readable summary
    expect(msg.body).toBe('[poll vote] "What to buy?" → Buy milk');

    // Structured payload is present
    expect(msg.pollVote).toEqual({
      pollMsgId: "poll-abc",
      question: "What to buy?",
      selectedOptions: ["Buy milk"],
      allOptions: ["Buy milk", "Buy eggs", "Buy bread"],
    });

    await listener.close();
  });

  it("includes multiple selected options when voter picks more than one", async () => {
    matchPollOptionsMock.mockReturnValue(["Buy milk", "Buy bread"]);

    const onMessage = vi.fn();
    const listener = await monitorWebInbox({ verbose: false, onMessage });
    const sock = await createWaSocket();

    sock.ev.emit("messages.upsert", pollUpsert({}));
    await new Promise((resolve) => setImmediate(resolve));

    const msg = onMessage.mock.calls[0][0];
    expect(msg.body).toBe('[poll vote] "What to buy?" → Buy milk, Buy bread');
    expect(msg.pollVote?.selectedOptions).toEqual(["Buy milk", "Buy bread"]);

    await listener.close();
  });

  it("drops the vote silently when the poll is not in the store", async () => {
    getPollMock.mockReturnValue(null); // unknown poll

    const onMessage = vi.fn();
    const listener = await monitorWebInbox({ verbose: false, onMessage });
    const sock = await createWaSocket();

    sock.ev.emit("messages.upsert", pollUpsert({}));
    await new Promise((resolve) => setImmediate(resolve));

    expect(onMessage).not.toHaveBeenCalled();

    await listener.close();
  });

  it("drops the vote silently when decryption throws", async () => {
    decryptPollVoteMock.mockImplementation(() => {
      throw new Error("bad decrypt");
    });

    const onMessage = vi.fn();
    const listener = await monitorWebInbox({ verbose: false, onMessage });
    const sock = await createWaSocket();

    sock.ev.emit("messages.upsert", pollUpsert({}));
    await new Promise((resolve) => setImmediate(resolve));

    expect(onMessage).not.toHaveBeenCalled();

    await listener.close();
  });

  it("does not set pollVote on ordinary text messages", async () => {
    const onMessage = vi.fn();
    const listener = await monitorWebInbox({ verbose: false, onMessage });
    const sock = await createWaSocket();

    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { id: "txt-1", fromMe: false, remoteJid: "555@s.whatsapp.net" },
          message: { conversation: "just a regular message" },
          messageTimestamp: 1_700_000_100,
        },
      ],
    });
    await new Promise((resolve) => setImmediate(resolve));

    const msg = onMessage.mock.calls[0][0];
    expect(msg.body).toBe("just a regular message");
    expect(msg.pollVote).toBeUndefined();

    await listener.close();
  });

  it("passes pollCreatorJid as selfJid when decrypting", async () => {
    const onMessage = vi.fn();
    const listener = await monitorWebInbox({ verbose: false, onMessage });
    const sock = await createWaSocket();

    sock.ev.emit("messages.upsert", pollUpsert({}));
    await new Promise((resolve) => setImmediate(resolve));

    // decryptPollVote should have been called with pollCreatorJid = selfJid ("123@s.whatsapp.net")
    expect(decryptPollVoteMock).toHaveBeenCalledWith(
      expect.objectContaining({ encPayload: expect.any(Buffer), encIv: expect.any(Buffer) }),
      expect.objectContaining({
        pollCreatorJid: "123@s.whatsapp.net",
        pollMsgId: "poll-abc",
        voterJid: "555@s.whatsapp.net",
      }),
    );

    await listener.close();
  });
});
