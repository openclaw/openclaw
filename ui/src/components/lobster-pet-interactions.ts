import type { ReactiveController, ReactiveControllerHost } from "lit";
import { playLobsterPetChirp, type LobsterPetChirpKind } from "./lobster-pet-audio.ts";
import { prefersReducedMotion } from "./lobster-pet-plans.ts";

type LobsterInteractionHooks = {
  soundsEnabled: () => boolean;
  canHuff: () => boolean;
  canGaze: () => boolean;
  onGrumpyChange: (grumpy: boolean) => void;
  onAct: (act: "pet" | "startle") => void;
  onFacing: (facing: 1 | -1) => void;
  onHuff: () => void;
};

export class LobsterPetInteractions implements ReactiveController {
  private grumpyTimer: number | null = null;
  private holdTimer: number | null = null;
  private audioCtx: AudioContext | null = null;
  private pokeTimes: number[] = [];
  private lastGazeAt = 0;

  constructor(
    private readonly host: ReactiveControllerHost & HTMLElement,
    private readonly hooks: LobsterInteractionHooks,
  ) {
    host.addController(this);
  }

  hostConnected() {
    document.addEventListener("pointermove", this.handleGaze, { passive: true });
  }

  hostDisconnected() {
    document.removeEventListener("pointermove", this.handleGaze);
    this.handleHoldCancel();
    this.clearGrumpyTimer();
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
  }

  suspend() {
    this.handleHoldCancel();
    this.clearGrumpyTimer();
    this.hooks.onGrumpyChange(false);
  }

  // Press-and-hold pets the lobster; a quick tap pokes. Three fast pokes
  // turn it grumpy, ten end its visit. Offline pets never huff.
  readonly handleHoldStart = (event: PointerEvent) => {
    if (event.button !== 0 || prefersReducedMotion()) {
      return;
    }
    if (this.holdTimer !== null) {
      window.clearTimeout(this.holdTimer);
    }
    this.holdTimer = window.setTimeout(() => {
      this.holdTimer = null;
      this.hooks.onGrumpyChange(false);
      this.playChirp("pet");
      this.hooks.onAct("pet");
    }, 600);
  };

  readonly handleHoldEnd = (event: PointerEvent) => {
    if (event.button !== 0) {
      return;
    }
    if (this.holdTimer !== null) {
      window.clearTimeout(this.holdTimer);
      this.holdTimer = null;
      this.pokeNow();
    }
  };

  readonly handleHoldCancel = () => {
    if (this.holdTimer !== null) {
      window.clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
  };

  private playChirp(kind: LobsterPetChirpKind) {
    this.audioCtx = playLobsterPetChirp(this.audioCtx, this.hooks.soundsEnabled(), kind);
  }

  private pokeNow() {
    this.playChirp("poke");
    const now = Date.now();
    this.pokeTimes = [...this.pokeTimes.filter((at) => now - at < 6000), now];
    if (this.pokeTimes.length >= 10 && this.hooks.canHuff()) {
      this.huffOff();
      return;
    }
    if (this.pokeTimes.length >= 3) {
      this.enterGrumpy();
    }
    this.hooks.onAct("startle");
  }

  private clearGrumpyTimer() {
    if (this.grumpyTimer !== null) {
      window.clearTimeout(this.grumpyTimer);
      this.grumpyTimer = null;
    }
  }

  private enterGrumpy() {
    this.hooks.onGrumpyChange(true);
    this.clearGrumpyTimer();
    this.grumpyTimer = window.setTimeout(() => {
      this.grumpyTimer = null;
      this.hooks.onGrumpyChange(false);
    }, 60_000);
  }

  private huffOff() {
    this.pokeTimes = [];
    this.hooks.onGrumpyChange(false);
    // Ends this visit only; the host schedules the resident's later return.
    this.hooks.onHuff();
  }

  // Gaze follows the pointer between acts and stays inert under reduced motion.
  private readonly handleGaze = (event: PointerEvent) => {
    if (!this.hooks.canGaze() || prefersReducedMotion()) {
      return;
    }
    const now = Date.now();
    if (now - this.lastGazeAt < 120) {
      return;
    }
    this.lastGazeAt = now;
    const sprite = this.host.querySelector(".lobster-pet:not(.lobster-pet--shell)");
    if (!sprite) {
      return;
    }
    const rect = sprite.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    this.hooks.onFacing(event.clientX < centerX ? -1 : 1);
  };
}
