// Passers and bottles have seeded clocks independent of the resident's visits.
import { expectDefined } from "@openclaw/normalization-core";
import {
  LOBSTER_BOTTLE_FORTUNES,
  resolveLobsterPasserCrossMs,
  planLobsterBottle,
  planLobsterPasser,
  prefersReducedMotion,
  type LobsterPasserPlan,
  type LobsterPasserOptions,
} from "./lobster-pet-plans.ts";
import { LobsterPetTimers } from "./lobster-pet-timers.ts";

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

export class LobsterLedgeTraffic {
  passer: LobsterPasserPlan | null = null;
  bottle: LobsterBottleScene | null = null;
  private connected = false;
  private readonly timers = new LobsterPetTimers<
    "passerTimer" | "passerEndTimer" | "passerWatchTimer" | "bottleTimer" | "bottleEndTimer"
  >();
  private seed: number | null = null;
  private passerConsumed = false;
  private crossingMs = 0;

  constructor(
    private readonly notify: () => void,
    private readonly hooks: LobsterTrafficHooks,
  ) {}

  connect() {
    this.connected = true;
  }

  update() {
    if (!this.hooks.visitsEnabled()) {
      this.clearTimers();
      this.passer = null;
      this.bottle = null;
    }
  }

  dispose() {
    this.connected = false;
    this.clearTimers();
    // Clear visible guests so a reconnect cannot show a stopped passer or bottle.
    this.passer = null;
    this.bottle = null;
    this.notify();
  }

  // Only a new seed restores a crossing already consumed by this load.
  reset(seed: number) {
    if (seed !== this.seed) {
      this.seed = seed;
      this.passerConsumed = false;
    }
    this.clearTimers();
    this.passer = null;
    this.bottle = null;
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

  readonly openBottle = () => {
    if (!this.bottle || this.bottle.opened) {
      return;
    }
    this.bottle = { ...this.bottle, opened: true };
    this.armBottleEbb(120_000);
    this.notify();
  };

  private clearTimers() {
    this.clearPasserTimers();
    this.timers.clear("bottleTimer", "bottleEndTimer");
  }

  private clearPasserTimers() {
    this.timers.clear("passerTimer", "passerEndTimer", "passerWatchTimer");
  }

  private schedulePasser(seed: number) {
    if (this.passerConsumed) {
      return;
    }
    const plan = planLobsterPasser(seed, this.hooks.passerOptions());
    if (!plan || prefersReducedMotion()) {
      return;
    }
    this.timers.schedule("passerTimer", plan.atMs, () => {
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
      this.notify();
      const crossMs = this.passerCrossMs();
      this.hooks.onPasserFacing(plan.direction === 1 ? -1 : 1);
      this.timers.schedule("passerWatchTimer", crossMs / 2, () => {
        this.hooks.onPasserFacing(plan.direction);
        this.hooks.onPasserMidCross();
        this.notify();
      });
      this.timers.schedule("passerEndTimer", crossMs, () => {
        this.passer = null;
        this.notify();
        this.hooks.onPasserDone();
      });
    });
  }

  private scheduleBottle(seed: number) {
    const plan = planLobsterBottle(seed);
    if (!plan) {
      return;
    }
    this.timers.schedule("bottleTimer", plan.atMs, () => {
      if (!this.connected || !this.hooks.visitsEnabled()) {
        return;
      }
      this.bottle = {
        spotPct: plan.spotPct,
        opened: false,
        fortune: expectDefined(
          LOBSTER_BOTTLE_FORTUNES[plan.fortuneIndex],
          "lobster bottle fortune",
        ),
      };
      this.notify();
      this.armBottleEbb(300_000);
    });
  }

  private armBottleEbb(delayMs: number) {
    this.timers.clear("bottleEndTimer");
    this.timers.schedule("bottleEndTimer", delayMs, () => {
      this.bottle = null;
      this.notify();
    });
  }
}
