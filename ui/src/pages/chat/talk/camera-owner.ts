import { listen } from "../../../lib/reactive/listener.ts";
import { openRealtimeTalkCamera } from "./input.ts";

type RealtimeTalkCameraOwnerOptions = {
  getDeviceId: () => string | undefined;
  setDeviceId: (deviceId: string | undefined) => void;
  isClosed: () => boolean;
  onStream: (stream: MediaStream | null) => void;
  onAcquired?: () => void;
  onReleased?: () => void;
};

// Owns camera tracks and their ended listeners; release detaches listeners before stopping tracks.
export class RealtimeTalkCameraOwner {
  stream: MediaStream | null = null;
  video: HTMLVideoElement | null = null;
  private setupController: AbortController | null = null;
  private trackListeners: (() => void)[] = [];
  private readonly handleTrackEnded = () => this.release();

  constructor(private readonly options: RealtimeTalkCameraOwnerOptions) {}

  async setEnabled(enabled: boolean): Promise<void> {
    if (!enabled) {
      this.release();
      return;
    }
    if (this.options.isClosed()) {
      throw new Error("Realtime Talk session is closed");
    }
    if (this.hasLiveTrack()) {
      return;
    }
    this.setupController?.abort();
    const controller = new AbortController();
    this.setupController = controller;
    let stream: MediaStream;
    try {
      stream = await openRealtimeTalkCamera(this.options.getDeviceId(), {
        signal: controller.signal,
      });
    } catch (error) {
      if (this.options.isClosed() || controller.signal.aborted) {
        return;
      }
      throw error;
    } finally {
      if (this.setupController === controller) {
        this.setupController = null;
      }
    }
    if (this.options.isClosed() || controller.signal.aborted) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.stream = stream;
    this.trackListeners.forEach((stop) => stop());
    this.trackListeners = stream
      .getVideoTracks()
      .map((track) => listen(track, "ended", this.handleTrackEnded, { once: true }));
    const video = document.createElement("video");
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    this.video = video;
    this.options.onStream(stream);
    void video.play().catch(() => undefined);
    this.options.onAcquired?.();
  }

  async switchDevice(videoDeviceId: string | undefined): Promise<void> {
    const nextDeviceId = videoDeviceId?.trim() || undefined;
    const previousDeviceId =
      this.stream?.getVideoTracks()[0]?.getSettings?.().deviceId?.trim() ||
      this.options.getDeviceId();
    const shouldReacquire = this.stream !== null || this.setupController !== null;
    this.options.setDeviceId(nextDeviceId);
    if (!shouldReacquire) {
      return;
    }
    this.release();
    try {
      await this.setEnabled(true);
    } catch (error) {
      if (!this.options.isClosed() && previousDeviceId !== nextDeviceId) {
        this.options.setDeviceId(previousDeviceId);
        try {
          await this.setEnabled(true);
        } catch {
          // Keep the original switch failure as the actionable error.
        }
      }
      throw error;
    }
  }

  hasLiveTrack(): boolean {
    return this.stream?.getVideoTracks().some((track) => track.readyState === "live") === true;
  }

  hasUsableTrack(): boolean {
    return (
      this.stream
        ?.getVideoTracks()
        .some((track) => track.readyState === "live" && track.enabled && !track.muted) === true
    );
  }

  release(): void {
    this.setupController?.abort();
    this.setupController = null;
    this.options.onReleased?.();
    this.trackListeners.forEach((stop) => stop());
    this.trackListeners = [];
    this.stream?.getVideoTracks().forEach((track) => {
      track.stop();
    });
    this.stream = null;
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
    this.options.onStream(null);
  }
}
