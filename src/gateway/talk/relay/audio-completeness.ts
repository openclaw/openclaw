import type { TalkRealtimeRelayEventData } from "./event.types.js";

type AudioStatus = "completed" | "cancelled" | "failed" | "incomplete";
export type RelayAudioOutput = {
  id: number;
  /** Zero-based on audio; total generated frame count on audioDone. */
  frameCount: number;
};

type Marker =
  | { type: "audioStarted"; outputId: number }
  | { type: "audioDone"; status: AudioStatus; output: RelayAudioOutput };

/** Loss detection, not retransmission: constant memory and no retained audio. */
export class RelayAudioCompleteness {
  private nextId = 0;
  private current?: RelayAudioOutput;
  private invalidated = false;
  private turnId?: string;

  observe(
    event: TalkRealtimeRelayEventData,
    turnId: string | undefined,
    emit: (marker: Marker) => void,
  ): RelayAudioOutput | undefined {
    const start = () => {
      if (!this.current) {
        this.current = { id: ++this.nextId, frameCount: 0 };
        emit({ type: "audioStarted", outputId: this.current.id });
      }
      return this.current;
    };
    const finish = (status: AudioStatus) => {
      if (this.current) {
        emit({ type: "audioDone", status, output: { ...this.current } });
        this.current = undefined;
      }
    };
    switch (event.type) {
      case "responseStarted":
        if (this.current && this.turnId === event.turnId) {
          break;
        }
        this.turnId = event.turnId;
        // A missing provider terminal must never bless the preceding output.
        finish("incomplete");
        this.invalidated = false;
        start();
        break;
      case "audio": {
        if (this.invalidated && (!turnId || turnId === this.turnId)) {
          break;
        }
        this.turnId = turnId;
        this.invalidated = false;
        const current = start();
        return { id: current.id, frameCount: current.frameCount++ };
      }
      case "audioDone": {
        if (this.invalidated && (!turnId || turnId === this.turnId)) {
          break;
        }
        this.turnId = turnId;
        const output = { ...start() };
        this.current = undefined;
        this.invalidated = true;
        return output;
      }
      case "clear":
      case "close":
      case "error":
        finish(event.type === "clear" ? "cancelled" : "incomplete");
        this.invalidated = true;
        break;
      default:
        break;
    }
    return undefined;
  }
}
