// The ledge's uninvited guests: pass-through visitors (strangers, the crab,
// the snail, the duck, the jellyfish) and the message in a bottle. Both run
// on their own seeded clocks, independent of the resident's visit schedule;
// a ReactiveController keeps the pet element focused on the resident.
import { expectDefined } from "@openclaw/normalization-core";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import {
  LOBSTER_BOTTLE_FORTUNES,
  resolveLobsterPasserCrossMs,
  planLobsterBottle,
  planLobsterPasser,
  prefersReducedMotion,
  type LobsterBottlePlan,
  type LobsterPasserPlan,
  type LobsterPasserOptions,
} from "./lobster-pet-plans.ts";

// Facing, reactions, and the act loop stay owned by the pet element; the
// controller only reports crossing milestones.
type LobsterTrafficHooks = {
  visitsEnabled: () => boolean;
  passerOptions: () => LobsterPasserOptions;
  onPasserStart: (plan: LobsterPasserPlan) => void;
  // Fired at crossing start (toward the entry side) and mid-cross (travel
  // direction) so the resident can watch the traffic go by.
  onPasserFacing: (facing: 1 | -1) => void;
  onPasserMidCross: () => void;
  onPasserDone: () => void;
};

type LobsterBottleScene = { spotPct: number; opened: boolean; fortune: string };

export class LobsterLedgeTraffic implements ReactiveController {
  passer: LobsterPasserPlan | null = null;
  private connected = false;
  private bottlePlan: LobsterBottlePlan | null = null;
  private bottleVisible = false;
  private bottleOpened = false;
  private passerTimer: number | null = null;
  private passerEndTimer: number | null = null;
  private passerWatchTimer: number | null = null;
  private seed: number | null = null;
  private passerConsumed = false;
  private crossingMs = 0;
  private bottleTimer: number | null = null;
  private bottleEndTimer: number | null = null;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly hooks: LobsterTrafficHooks,
  ) {
    host.addController(this);
  }

  hostConnected() {
    this.connected = true;
  }

  hostUpdate() {
    if (!this.hooks.visitsEnabled()) {
      this.clearTimers();
      this.passer = null;
      this.bottleVisible = false;
    }
  }

  hostDisconnected() {
    this.connected = false;
    this.clearTimers();
    // The show ends with the host, mirroring the pet's own visit timers
    // (which also die on disconnect and only re-arm on a seed change):
    // clear visible guests so a reconnect never shows a frozen passer or an
    // unebbing bottle. The update request flushes on reattach.
    this.passer = null;
    this.bottleVisible = false;
    this.host.requestUpdate();
  }

  // Only a new seed restores a crossing already consumed by this load.
  reset(seed: number) {
    if (seed !== this.seed) {
      this.seed = seed;
      this.passerConsumed = false;
    }
    this.clearTimers();
    this.passer = null;
    this.bottleVisible = false;
    this.bottleOpened = false;
    if (this.connected && this.hooks.visitsEnabled()) {
      this.schedulePasser(seed);
      this.scheduleBottle(seed);
    }
  }

  replanPasser(seed: number) {
    const passer = this.passer;
    const options = this.hooks.passerOptions();
    const regular =
      passer && ["stranger", "crab", "snail", "duck", "jellyfish"].includes(passer.kind);
    if (
      passer &&
      (passer.kind !== "stranger" ||
        options.strangers !== false ||
        options.critters?.includes(passer.kind)) &&
      (regular || options.critters?.includes(passer.kind))
    ) {
      return;
    }
    const wasCrossing = this.passer !== null;
    this.clearPasserTimers();
    this.passer = null;
    if (wasCrossing) {
      this.hooks.onPasserDone();
    }
    if (this.connected && this.hooks.visitsEnabled()) {
      this.schedulePasser(seed);
    }
  }

  passerCrossMs(): number {
    return this.passer ? this.crossingMs : 0;
  }

  bottle(): LobsterBottleScene | null {
    if (!this.bottleVisible || !this.bottlePlan) {
      return null;
    }
    return {
      spotPct: this.bottlePlan.spotPct,
      opened: this.bottleOpened,
      fortune: expectDefined(
        LOBSTER_BOTTLE_FORTUNES[this.bottlePlan.fortuneIndex],
        "lobster bottle fortune",
      ),
    };
  }

  readonly openBottle = () => {
    if (this.bottleOpened || !this.bottleVisible) {
      return;
    }
    this.bottleOpened = true;
    // Read, then reclaimed by the sea a couple of minutes later.
    this.armBottleEbb(120_000);
    this.host.requestUpdate();
  };

  private clearTimers() {
    this.clearPasserTimers();
    for (const timer of [this.bottleTimer, this.bottleEndTimer]) {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    }
    this.bottleTimer = null;
    this.bottleEndTimer = null;
  }

  private clearPasserTimers() {
    for (const timer of [this.passerTimer, this.passerEndTimer, this.passerWatchTimer]) {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    }
    this.passerTimer = null;
    this.passerEndTimer = null;
    this.passerWatchTimer = null;
  }

  private schedulePasser(seed: number) {
    if (this.passerConsumed) {
      return;
    }
    const plan = planLobsterPasser(seed, this.hooks.passerOptions());
    if (!plan || prefersReducedMotion()) {
      return;
    }
    this.passerTimer = window.setTimeout(() => {
      this.passerTimer = null;
      // A crossing gets one chance per load, even after theme or preference refreshes.
      this.passerConsumed = true;
      if (
        !this.connected ||
        !this.hooks.visitsEnabled() ||
        document.hidden ||
        prefersReducedMotion()
      ) {
        return;
      }
      this.hooks.onPasserStart(plan);
      this.passer = plan;
      this.crossingMs = resolveLobsterPasserCrossMs(
        plan.kind,
        this.hooks.passerOptions().critterArtwork,
      );
      this.host.requestUpdate();
      const crossMs = this.passerCrossMs();
      this.hooks.onPasserFacing(plan.direction === 1 ? -1 : 1);
      this.passerWatchTimer = window.setTimeout(() => {
        this.passerWatchTimer = null;
        this.hooks.onPasserFacing(plan.direction);
        // Mid-crossing is when the passer is closest: friends wave at the
        // traffic, shy pets duck for a peek, regulars just watch it pass.
        this.hooks.onPasserMidCross();
      }, crossMs / 2);
      this.passerEndTimer = window.setTimeout(() => {
        this.passerEndTimer = null;
        this.passer = null;
        this.host.requestUpdate();
        this.hooks.onPasserDone();
      }, crossMs);
    }, plan.atMs);
  }

  // The bottle keeps its own clock: it washes up whether or not the pet is
  // around, waits to be opened, and drifts back out with the tide.
  private scheduleBottle(seed: number) {
    this.bottlePlan = planLobsterBottle(seed);
    if (!this.bottlePlan) {
      return;
    }
    this.bottleTimer = window.setTimeout(() => {
      this.bottleTimer = null;
      if (!this.connected || !this.hooks.visitsEnabled()) {
        return;
      }
      this.bottleVisible = true;
      this.host.requestUpdate();
      this.armBottleEbb(300_000);
    }, this.bottlePlan.atMs);
  }

  private armBottleEbb(delayMs: number) {
    if (this.bottleEndTimer !== null) {
      window.clearTimeout(this.bottleEndTimer);
    }
    this.bottleEndTimer = window.setTimeout(() => {
      this.bottleEndTimer = null;
      this.bottleVisible = false;
      this.host.requestUpdate();
    }, delayMs);
  }
}
