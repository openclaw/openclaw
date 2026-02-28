import { ChannelType } from "@buape/carbon";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createConnectionMock,
  joinVoiceChannelMock,
  entersStateMock,
  createAudioPlayerMock,
  resolveAgentRouteMock,
} = vi.hoisted(() => {
  type EventHandler = (...args: unknown[]) => unknown;
  type MockConnection = {
    destroy: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    receiver: {
      speaking: {
        on: ReturnType<typeof vi.fn>;
        off: ReturnType<typeof vi.fn>;
      };
      subscribe: ReturnType<typeof vi.fn>;
    };
    handlers: Map<string, EventHandler>;
  };

  const createConnectionMock = (): MockConnection => {
    const handlers = new Map<string, EventHandler>();
    const connection: MockConnection = {
      destroy: vi.fn(),
      subscribe: vi.fn(),
      on: vi.fn((event: string, handler: EventHandler) => {
        handlers.set(event, handler);
      }),
      off: vi.fn(),
      receiver: {
        speaking: {
          on: vi.fn(),
          off: vi.fn(),
        },
        subscribe: vi.fn(() => ({
          on: vi.fn(),
          [Symbol.asyncIterator]: async function* () {},
        })),
      },
      handlers,
    };
    return connection;
  };

  return {
    createConnectionMock,
    joinVoiceChannelMock: vi.fn(() => createConnectionMock()),
    entersStateMock: vi.fn(async (_target?: unknown, _state?: string, _timeoutMs?: number) => {
      return undefined;
    }),
    createAudioPlayerMock: vi.fn(() => ({
      on: vi.fn(),
      off: vi.fn(),
      stop: vi.fn(),
      play: vi.fn(),
      state: { status: "idle" },
    })),
    resolveAgentRouteMock: vi.fn(() => ({ agentId: "agent-1", sessionKey: "discord:g1:c1" })),
  };
});

vi.mock("@discordjs/voice", () => ({
  AudioPlayerStatus: { Playing: "playing", Idle: "idle" },
  EndBehaviorType: { AfterSilence: "AfterSilence" },
  VoiceConnectionStatus: {
    Ready: "ready",
    Disconnected: "disconnected",
    Destroyed: "destroyed",
    Signalling: "signalling",
    Connecting: "connecting",
  },
  createAudioPlayer: createAudioPlayerMock,
  createAudioResource: vi.fn(),
  entersState: entersStateMock,
  joinVoiceChannel: joinVoiceChannelMock,
}));

vi.mock("../../routing/resolve-route.js", () => ({
  resolveAgentRoute: resolveAgentRouteMock,
}));

let managerModule: typeof import("./manager.js");

function createClient() {
  return {
    fetchChannel: vi.fn(async (channelId: string) => ({
      id: channelId,
      guildId: "g1",
      type: ChannelType.GuildVoice,
    })),
    getPlugin: vi.fn(() => ({
      getGatewayAdapterCreator: vi.fn(() => vi.fn()),
    })),
    fetchMember: vi.fn(),
    fetchUser: vi.fn(),
  };
}

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

describe("DiscordVoiceManager", () => {
  beforeAll(async () => {
    managerModule = await import("./manager.js");
  });

  beforeEach(() => {
    joinVoiceChannelMock.mockReset();
    joinVoiceChannelMock.mockImplementation(() => createConnectionMock());
    entersStateMock.mockReset();
    entersStateMock.mockResolvedValue(undefined);
    createAudioPlayerMock.mockClear();
    resolveAgentRouteMock.mockClear();
  });

  it("keeps the new session when an old disconnected handler fires", async () => {
    const oldConnection = createConnectionMock();
    const newConnection = createConnectionMock();
    joinVoiceChannelMock.mockReturnValueOnce(oldConnection).mockReturnValueOnce(newConnection);
    entersStateMock.mockImplementation(async (target: unknown, status?: string) => {
      if (target === oldConnection && (status === "signalling" || status === "connecting")) {
        throw new Error("old disconnected");
      }
      return undefined;
    });

    const manager = new managerModule.DiscordVoiceManager({
      client: createClient() as never,
      cfg: {},
      discordConfig: {},
      accountId: "default",
      runtime: createRuntime(),
    });

    await manager.join({ guildId: "g1", channelId: "c1" });
    await manager.join({ guildId: "g1", channelId: "c2" });

    const oldDisconnected = oldConnection.handlers.get("disconnected");
    expect(oldDisconnected).toBeTypeOf("function");
    await oldDisconnected?.();

    expect(manager.status()).toEqual([
      {
        ok: true,
        message: "connected: guild g1 channel c2",
        guildId: "g1",
        channelId: "c2",
      },
    ]);
  });

  it("keeps the new session when an old destroyed handler fires", async () => {
    const oldConnection = createConnectionMock();
    const newConnection = createConnectionMock();
    joinVoiceChannelMock.mockReturnValueOnce(oldConnection).mockReturnValueOnce(newConnection);

    const manager = new managerModule.DiscordVoiceManager({
      client: createClient() as never,
      cfg: {},
      discordConfig: {},
      accountId: "default",
      runtime: createRuntime(),
    });

    await manager.join({ guildId: "g1", channelId: "c1" });
    await manager.join({ guildId: "g1", channelId: "c2" });

    const oldDestroyed = oldConnection.handlers.get("destroyed");
    expect(oldDestroyed).toBeTypeOf("function");
    oldDestroyed?.();

    expect(manager.status()).toEqual([
      {
        ok: true,
        message: "connected: guild g1 channel c2",
        guildId: "g1",
        channelId: "c2",
      },
    ]);
  });

  it("removes voice listeners on leave", async () => {
    const connection = createConnectionMock();
    joinVoiceChannelMock.mockReturnValueOnce(connection);
    const manager = new managerModule.DiscordVoiceManager({
      client: createClient() as never,
      cfg: {},
      discordConfig: {},
      accountId: "default",
      runtime: createRuntime(),
    });

    await manager.join({ guildId: "g1", channelId: "c1" });
    await manager.leave({ guildId: "g1" });

    const player = createAudioPlayerMock.mock.results[0]?.value;
    expect(connection.receiver.speaking.off).toHaveBeenCalledWith("start", expect.any(Function));
    expect(connection.off).toHaveBeenCalledWith("disconnected", expect.any(Function));
    expect(connection.off).toHaveBeenCalledWith("destroyed", expect.any(Function));
    expect(player.off).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("passes DAVE options to joinVoiceChannel", async () => {
    const manager = new managerModule.DiscordVoiceManager({
      client: createClient() as never,
      cfg: {},
      discordConfig: {
        voice: {
          daveEncryption: false,
          decryptionFailureTolerance: 8,
        },
      },
      accountId: "default",
      runtime: createRuntime(),
    });

    await manager.join({ guildId: "g1", channelId: "c1" });

    expect(joinVoiceChannelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        daveEncryption: false,
        decryptionFailureTolerance: 8,
      }),
    );
  });

  it("attempts rejoin after repeated decrypt failures", async () => {
    const manager = new managerModule.DiscordVoiceManager({
      client: createClient() as never,
      cfg: {},
      discordConfig: {},
      accountId: "default",
      runtime: createRuntime(),
    });

    await manager.join({ guildId: "g1", channelId: "c1" });

    const entry = (manager as unknown as { sessions: Map<string, unknown> }).sessions.get("g1");
    expect(entry).toBeDefined();
    (
      manager as unknown as { handleReceiveError: (e: unknown, err: unknown) => void }
    ).handleReceiveError(
      entry,
      new Error("Failed to decrypt: DecryptionFailed(UnencryptedWhenPassthroughDisabled)"),
    );
    (
      manager as unknown as { handleReceiveError: (e: unknown, err: unknown) => void }
    ).handleReceiveError(
      entry,
      new Error("Failed to decrypt: DecryptionFailed(UnencryptedWhenPassthroughDisabled)"),
    );
    (
      manager as unknown as { handleReceiveError: (e: unknown, err: unknown) => void }
    ).handleReceiveError(
      entry,
      new Error("Failed to decrypt: DecryptionFailed(UnencryptedWhenPassthroughDisabled)"),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2);
  });

  describe("interruptThresholdMs", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    async function makeManagerWithSpeakingHandler(discordConfig: Record<string, unknown> = {}) {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const manager = new managerModule.DiscordVoiceManager({
        client: createClient() as never,
        cfg: {},
        discordConfig,
        accountId: "default",
        runtime: createRuntime(),
      });
      await manager.join({ guildId: "g1", channelId: "c1" });
      const player = createAudioPlayerMock.mock.results[
        createAudioPlayerMock.mock.results.length - 1
      ]?.value as { stop: ReturnType<typeof vi.fn>; state: { status: string } };
      const speakingOn = connection.receiver.speaking.on as ReturnType<typeof vi.fn>;
      const speakingHandler = speakingOn.mock.calls[0]?.[1] as
        | ((userId: string) => void)
        | undefined;
      return { manager, player, speakingHandler, connection };
    }

    it("stops playback immediately when interruptThresholdMs is 0", async () => {
      const { player, speakingHandler } = await makeManagerWithSpeakingHandler({
        voice: { interruptThresholdMs: 0 },
      });
      player.state.status = "playing";
      speakingHandler?.("user-1");
      expect(player.stop).toHaveBeenCalledWith(true);
    });

    it("defers stop when interruptThresholdMs > 0 and user stops quickly", async () => {
      const { player, speakingHandler } = await makeManagerWithSpeakingHandler({
        voice: { interruptThresholdMs: 400 },
      });
      player.state.status = "playing";
      speakingHandler?.("user-1");
      // Before threshold fires, user is no longer in activeSpeakers (stream ended quickly)
      // activeSpeakers is cleared after the stream ends — simulate by advancing time
      expect(player.stop).not.toHaveBeenCalled();
      vi.advanceTimersByTime(400);
      // activeSpeakers would be empty (stream ended), so stop should NOT be called
      expect(player.stop).not.toHaveBeenCalled();
    });

    it("stops playback after threshold if user is still speaking", async () => {
      const { player, speakingHandler, connection } = await makeManagerWithSpeakingHandler({
        voice: { interruptThresholdMs: 400 },
      });
      // Simulate a never-ending stream so activeSpeakers stays populated
      const neverEndingStream = {
        on: vi.fn(),
        [Symbol.asyncIterator]: async function* () {
          // never yields
          await new Promise(() => {});
        },
      };
      (connection.receiver.subscribe as ReturnType<typeof vi.fn>).mockReturnValueOnce(
        neverEndingStream,
      );
      player.state.status = "playing";
      speakingHandler?.("user-2");
      expect(player.stop).not.toHaveBeenCalled();
      vi.advanceTimersByTime(400);
      // user-2 is still in activeSpeakers (stream never ended), so playback should stop
      expect(player.stop).toHaveBeenCalledWith(true);
    });

    it("uses default threshold of 400ms when not configured", async () => {
      const { player, speakingHandler } = await makeManagerWithSpeakingHandler({});
      player.state.status = "playing";
      speakingHandler?.("user-1");
      expect(player.stop).not.toHaveBeenCalled();
      vi.advanceTimersByTime(399);
      expect(player.stop).not.toHaveBeenCalled();
    });
  });
});
