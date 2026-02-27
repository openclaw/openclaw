declare module "@discordjs/voice" {
  import type { Readable } from "node:stream";

  export enum AudioPlayerStatus {
    Idle = "idle",
    Buffering = "buffering",
    Playing = "playing",
    AutoPaused = "autopaused",
    Paused = "paused",
  }

  export enum EndBehaviorType {
    Manual = 0,
    AfterSilence = 1,
    AfterInactivity = 2,
  }

  export enum VoiceConnectionStatus {
    Signalling = "signalling",
    Connecting = "connecting",
    Ready = "ready",
    Disconnected = "disconnected",
    Destroyed = "destroyed",
  }

  export type AudioPlayer = {
    play(resource: AudioResource): void;
    stop(force?: boolean): boolean;
    on(event: "error", listener: (error: Error) => void): AudioPlayer;
    on(event: string, listener: (...args: unknown[]) => void): AudioPlayer;
    off(event: "error", listener: (error: Error) => void): AudioPlayer;
    off(event: string, listener: (...args: unknown[]) => void): AudioPlayer;
    state: { status: AudioPlayerStatus };
  };

  export type AudioResource = {
    readonly playbackDuration: number;
  };

  export type SpeakingMap = {
    on(event: "start", listener: (userId: string) => void): SpeakingMap;
    on(event: "end", listener: (userId: string) => void): SpeakingMap;
    off(event: "start", listener: (userId: string) => void): SpeakingMap;
    off(event: "end", listener: (userId: string) => void): SpeakingMap;
    on(event: string, listener: (...args: unknown[]) => void): SpeakingMap;
    off(event: string, listener: (...args: unknown[]) => void): SpeakingMap;
  };

  export type VoiceConnectionReceiver = {
    subscribe(
      userId: string,
      options?: { end?: { behavior: EndBehaviorType; duration: number } },
    ): Readable;
    speaking: SpeakingMap;
  };

  export type VoiceConnection = {
    subscribe(player: AudioPlayer): { unsubscribe(): void } | undefined;
    destroy(adapterAvailable?: boolean): void;
    rejoin(config?: { channelId?: string; selfDeaf?: boolean; selfMute?: boolean }): boolean;
    on(event: string, listener: (...args: unknown[]) => void): VoiceConnection;
    off(event: string, listener: (...args: unknown[]) => void): VoiceConnection;
    receiver: VoiceConnectionReceiver;
    state: { status: VoiceConnectionStatus };
  };

  export function createAudioPlayer(): AudioPlayer;

  export function createAudioResource(input: string | Readable): AudioResource;

  export function entersState<T extends { state: { status: string } }>(
    target: T,
    status: string,
    timeoutMs: number,
  ): Promise<T>;

  export function joinVoiceChannel(options: {
    channelId: string;
    guildId: string;
    adapterCreator: unknown;
    selfDeaf?: boolean;
    selfMute?: boolean;
    daveEncryption?: boolean;
    decryptionFailureTolerance?: number;
  }): VoiceConnection;
}
