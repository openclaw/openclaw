/** A rational media clock shared by every event in one live visual session. */
export type LiveVisualClock = Readonly<{
  unitsPerSecond: number;
}>;

export type LiveVisualAudioFormat = Readonly<{
  encoding: "pcm-s16le";
  sampleRateHz: number;
  channels: number;
}>;

export type LiveVisualVideoFormat = Readonly<{
  width: number;
  height: number;
  frameRate: number;
}>;

export type LiveVisualSessionOpenRequest = Readonly<{
  streamId: string;
  clock: LiveVisualClock;
  video: LiveVisualVideoFormat;
  audio?: LiveVisualAudioFormat;
}>;

/** Timed input owned by the integration that already owns the media session. */
export type LiveVisualInputEvent =
  | Readonly<{ type: "audio"; pts: number; data: Uint8Array }>
  | Readonly<{ type: "cue"; pts: number; name: string; value: string | number | boolean }>
  | Readonly<{ type: "flush"; reason?: string }>;

/** Browser surfaces are rendered directly by the subscribing video integration. */
export type LiveVisualOutput = Readonly<{
  kind: "browser-source";
  url: string;
  video: LiveVisualVideoFormat;
}>;

export type LiveVisualHealth = Readonly<{
  status: "starting" | "ready" | "degraded" | "closed";
  droppedMediaBytes: number;
  error?: string;
}>;

export type LiveVisualSession = {
  readonly output: LiveVisualOutput;
  write(event: LiveVisualInputEvent): boolean;
  health(): LiveVisualHealth;
  close(reason?: string): Promise<void>;
};

/** Provider of realtime visual surfaces driven by caller-owned timed media. */
export type LiveVisualProvider = {
  id: string;
  label: string;
  open(request: LiveVisualSessionOpenRequest): Promise<LiveVisualSession>;
};
