import { listen } from "../lib/reactive/listener.ts";
import { playLobsterPetChirp, type LobsterPetChirpKind } from "./lobster-pet-audio.ts";
import { prefersReducedMotion } from "./lobster-pet-plans.ts";
import { LobsterPetTimers } from "./lobster-pet-timers.ts";

type LobsterInteractionHooks = {
  soundsEnabled: () => boolean;
  canHuff: () => boolean;
  canGaze: () => boolean;
  onGrumpyChange: (grumpy: boolean) => void;
  onAct: (act: "pet" | "startle") => void;
  onFacing: (facing: 1 | -1) => void;
  onHuff: () => void;
};

export class LobsterPetInteractions {
  private readonly timers = new LobsterPetTimers<"grumpyTimer" | "holdTimer">();
  private audioCtx: AudioContext | null = null;
  private pokeTimes: number[] = [];
  private lastGazeAt = 0;
  private sprite: HTMLElement | undefined;
  private stopGaze?: () => void;

  constructor(private readonly hooks: LobsterInteractionHooks) {}

  readonly bindSprite = (element: HTMLElement) => {
    this.sprite = element;
  };

  connect() {
    this.stopGaze = listen(document, "pointermove", this.handleGaze, { passive: true });
  }

  dispose() {
    this.stopGaze?.();
    this.stopGaze = undefined;
    this.sprite = undefined;
    this.handleHoldCancel();
    this.timers.clear("grumpyTimer");
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
  }

  suspend() {
    this.handleHoldCancel();
    this.timers.clear("grumpyTimer");
    this.hooks.onGrumpyChange(false);
  }

  // Press-and-hold pets the lobster; a quick tap pokes. Three fast pokes
  // turn it grumpy, ten end its visit. Offline pets never huff.
  readonly handleHoldStart = (event: PointerEvent) => {
    if (event.button !== 0 || prefersReducedMotion()) {
      return;
    }
    this.handleHoldCancel();
    this.timers.schedule("holdTimer", 600, () => {
      this.hooks.onGrumpyChange(false);
      this.playChirp("pet");
      this.hooks.onAct("pet");
    });
  };

  readonly handleHoldEnd = (event: PointerEvent) => {
    if (event.button !== 0) {
      return;
    }
    if (this.timers.has("holdTimer")) {
      this.handleHoldCancel();
      this.pokeNow();
    }
  };

  readonly handleHoldCancel = () => this.timers.clear("holdTimer");

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

  private enterGrumpy() {
    this.hooks.onGrumpyChange(true);
    this.timers.clear("grumpyTimer");
    this.timers.schedule("grumpyTimer", 60_000, () => {
      this.hooks.onGrumpyChange(false);
    });
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
    const sprite = this.sprite;
    if (!sprite?.isConnected) {
      return;
    }
    const rect = sprite.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    this.hooks.onFacing(event.clientX < centerX ? -1 : 1);
  };
}
