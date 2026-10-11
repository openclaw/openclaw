import type { ThemeArtwork } from "../../../packages/gateway-protocol/src/theme.ts";
import { isLobsterDay } from "../../../src/shared/lobster-day.js";
import { patchSettings } from "../app/settings.ts";
import * as dex from "./lobster-dex.ts";
import * as contract from "./lobster-pet-contract.ts";
import type { LobsterPetDismissMenuPosition } from "./lobster-pet-dismiss-menu.tsx";
import * as lobsterLook from "./lobster-pet-identity.ts";
import { LobsterPetInteractions } from "./lobster-pet-interactions.ts";
import * as plans from "./lobster-pet-plans.ts";
import type { LobsterPetSceneProps } from "./lobster-pet-scene-view.tsx";
import {
  LobsterComposerGeometry,
  lobsterTravelDuration,
  type LobsterSceneTravel,
  type LobsterSceneMove,
} from "./lobster-pet-scene.ts";
import { LobsterPetTimers } from "./lobster-pet-timers.ts";
import { LobsterLedgeTraffic } from "./lobster-pet-traffic.ts";

type ResidentTimer =
  | "idleTimer"
  | "actEndTimer"
  | "enterTimer"
  | "visitTimer"
  | "leaveTimer"
  | "shellTimer"
  | "vigilTimer";

export type LobsterPetProps = {
  seed: number;
  mode: contract.LobsterPetMode;
  visitsEnabled: boolean;
  residentEnabled: boolean;
  critters: readonly string[] | undefined;
  critterArtwork: ThemeArtwork["critters"];
  floorEnabled: boolean;
  runOutcome: contract.LobsterRunOutcome;
  soundsEnabled: boolean;
  gatewayVersion: string | null;
  onVisitsDisabled: () => void;
};

/** Synchronous animation owner; Solid only observes committed scene snapshots. */
export class LobsterPetController {
  seed = 0;
  mode: contract.LobsterPetMode = "idle";

  visitsEnabled = true;
  residentEnabled = true;
  critters: readonly string[] | undefined;
  critterArtwork: ThemeArtwork["critters"];
  floorEnabled = false;
  runOutcome: contract.LobsterRunOutcome = "ok";
  soundsEnabled = false;
  gatewayVersion: string | null = null;
  onVisitsDisabled: () => void = () => undefined;

  private act: plans.LobsterPetAct | null = null;
  private spotPct = 80;
  private facing: 1 | -1 = 1;
  private entering = false;
  private entrance: contract.LobsterPetEntrance = "walk";
  private presence: "out" | "in" | "leaving" = "out";
  private anchor: plans.LobsterPetAnchor = "top";
  private readonly geometry = new LobsterComposerGeometry(
    this.host,
    () => this.residentEnabled && this.twinPlanned,
    () => this.refresh(),
  );
  private travel: LobsterSceneTravel | null = null;
  private travelScene = this.geometry.scene;
  private motionRng: () => number = lobsterLook.mulberry32(0);
  private passerAnchor: plans.LobsterPetAnchor = "top";
  private passerHops = false;
  private shellAnchor: plans.LobsterPetAnchor = "top";
  private scheduledVisiting = false;
  private dismissed = false;
  private dismissMenuPosition: LobsterPetDismissMenuPosition | null = null;
  private grumpy = false;
  private vigil = false;
  private outcomePresenceOwner: "vigil" | null = null;
  private movingDay = false;
  private movingDayChecked = false;
  private anniversary = false;
  private sailorDay = false;
  // Identity and familiarity remain load-start snapshots.
  private identity: plans.LobsterLoadIdentity | null = null;
  private entranceRng: () => number = lobsterLook.mulberry32(0);
  private readonly traffic = new LobsterLedgeTraffic(() => this.refresh(), {
    visitsEnabled: () => this.visitsEnabled && !this.dismissed,
    passerOptions: () => ({
      critters: this.critters,
      strangers: this.residentEnabled,
      critterArtwork: this.critterArtwork,
    }),
    onPasserStart: (plan) => {
      this.passerAnchor =
        plan.floor && this.floorEnabled && this.geometry.scene.floor ? "floor" : "top";
      this.passerHops =
        this.passerAnchor === "floor" && plan.hops && this.geometry.scene.passage !== null;
    },
    onPasserFacing: (facing) => this.watchTraffic(facing),
    onPasserMidCross: () => this.reactToPasser(),
    onPasserDone: () => this.scheduleNextAct(),
  });
  private readonly interactions = new LobsterPetInteractions(this.host, {
    soundsEnabled: () => this.soundsEnabled,
    canHuff: () => this.mode !== "offline",
    canGaze: () => this.presence === "in" && this.act === null && !this.vigil,
    onGrumpyChange: (grumpy) => {
      this.grumpy = grumpy;
      this.refresh();
    },
    onAct: (act) => {
      this.performAct(act);
      this.refresh();
    },
    onFacing: (facing) => {
      this.facing = facing;
      this.refresh();
    },
    onHuff: () => {
      this.timers.clear("visitTimer", "leaveTimer");
      this.scheduledVisiting = false;
      this.armArrival(
        lobsterLook.randomBetween(this.visitRng, plans.VISIT_GAP_MS[0], plans.VISIT_GAP_MS[1]),
      );
      this.refresh();
    },
  });
  private shellVisible = false;
  private shellSpotPct = 50;
  private shellScale = 2;
  private molted = false;
  private moltPlanned = false;
  private twinPlanned = false;
  private familiarity: dex.LobsterFamiliarity = {
    tier: "regular",
    wary: false,
    visits: 0,
    shoos: 0,
  };
  private greetedThisLoad = false;

  private look: contract.LobsterPetLook | null = null;
  private rng: () => number = lobsterLook.mulberry32(0);
  private visitRng: () => number = lobsterLook.mulberry32(0);
  private readonly timers = new LobsterPetTimers<ResidentTimer>(() => this.refresh());
  private restartPending = false;

  private active = false;

  constructor(
    private readonly host: HTMLElement,
    private notify: () => void,
    private readonly disableVisits: () => void,
  ) {}

  connect(notify: () => void) {
    this.notify = notify;
    this.look = null;
    this.active = true;
    this.geometry.connect();
    this.traffic.connect();
    this.interactions.connect();
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
  }

  dispose() {
    this.active = false;
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.clearActTimers();
    this.restartPending = false;
    this.scheduledVisiting = false;
    this.presence = "out";
    this.act = null;
    this.timers.clear("visitTimer", "leaveTimer", "shellTimer", "vigilTimer");
    this.geometry.dispose();
    this.traffic.dispose();
    this.interactions.dispose();
    this.notify = () => {};
  }

  update(props: LobsterPetProps) {
    const changed = new Map<string, unknown>();
    // SAFETY: the bridge supplies only the declared LobsterPetProps keys (plus unused children).
    for (const key of Object.keys(props) as (keyof LobsterPetProps)[]) {
      if (!Object.is(this[key], props[key])) {
        changed.set(key, this[key]);
      }
    }
    Object.assign(this, props);
    this.reconcile(changed);
    if (this.active) {
      this.notify();
    }
  }

  private refresh() {
    if (!this.active) {
      return;
    }
    this.reconcile(new Map());
    this.notify();
  }

  private wantsVisible(): boolean {
    return (
      this.visitsEnabled &&
      this.residentEnabled &&
      !this.dismissed &&
      (this.mode === "offline" ||
        this.vigil ||
        this.outcomePresenceOwner !== null ||
        this.scheduledVisiting)
    );
  }

  private reconcile(changed: Map<string, unknown>) {
    if (!this.active) {
      return;
    }
    const seedChanged = this.look === null || changed.has("seed");
    if (seedChanged) {
      this.look = lobsterLook.createLobsterPetLook(this.seed);
      this.rng = lobsterLook.mulberry32(this.seed ^ 0x9e3779b9);
      this.motionRng = lobsterLook.mulberry32(this.seed ^ 0xf1002);
      this.visitRng = lobsterLook.mulberry32(this.seed ^ 0x5eaf00d);
      this.entranceRng = lobsterLook.mulberry32((this.seed ^ 0xe27a) >>> 0);
      this.identity = plans.resolveLobsterLoadIdentity(this.seed, this.look);
      this.look = this.identity.look;
      this.spotPct = this.look.spotPct;
      this.facing = this.look.facing;
      // Reset the act loop before publishing the new load snapshot.
      this.clearActTimers();
      this.act = null;
      this.dismissed = false;
      this.dismissMenuPosition = null;
      this.presence = "out";
      this.molted = false;
      this.shellVisible = false;
      this.timers.clear("shellTimer");
      this.moltPlanned = plans.isLobsterMoltLoad(this.seed) && !this.identity.elder;
      this.twinPlanned = plans.isLobsterTwinLoad(this.seed);
      this.geometry.scheduleMeasure();
      this.familiarity = dex.getLobsterFamiliarity();
      this.sailorDay = isLobsterDay(new Date());
      this.greetedThisLoad = false;
      this.scheduleVisits();
      this.traffic.reset(this.seed);
      // The first update takes this branch, so the mode-change branch below
      // never sees the initial mode: arm the vigil tracker here as well.
      this.vigil = false;
      this.outcomePresenceOwner = null;
      this.trackVigil();
    } else if (changed.has("mode")) {
      const previousMode = changed.get("mode");
      const finished = previousMode === "busy" && this.mode === "idle";
      const presenceOwner = finished && this.vigil ? "vigil" : null;
      this.trackVigil();
      if (this.presence === "in" && !plans.prefersReducedMotion()) {
        const finishAct = plans.resolveLobsterFinishAct(this.runOutcome);
        this.performAct(finished ? finishAct : "startle", presenceOwner);
      }
    }
    if (changed.has("visitsEnabled") || changed.has("residentEnabled")) {
      if (this.visitsEnabled && changed.get("visitsEnabled") === false) {
        this.dismissed = false;
        this.traffic.reset(this.seed);
      }
      if (!this.visitsEnabled || !this.residentEnabled) {
        this.suspendResident();
      } else if (
        changed.get("visitsEnabled") === false ||
        changed.get("residentEnabled") === false
      ) {
        this.scheduleVisits();
        this.trackVigil();
      }
    }
    // SAFETY: update records this typed property before replacing it with the next props.
    const previousCritters = (changed.get("critters") as readonly string[] | undefined) ?? [];
    const critters = this.critters ?? [];
    const crittersChanged =
      changed.has("critters") &&
      (previousCritters.length !== critters.length ||
        previousCritters.some((kind, index) => kind !== critters[index]));
    if (!seedChanged && (changed.has("residentEnabled") || crittersChanged)) {
      this.traffic.replanPasser(this.seed);
      this.geometry.scheduleMeasure();
    }
    // A theme without the resident leaves its upgrade marker for a later visit.
    if (this.residentEnabled && !this.movingDayChecked && this.gatewayVersion) {
      this.movingDayChecked = true;
      this.movingDay = plans.detectLobsterMovingDay(this.gatewayVersion);
    }
    // The completed-Lobsterdex trim lives on the host so it survives the pet
    // being out; the visits setting and dismissals silence it too.
    this.host.toggleAttribute(
      "data-dex-complete",
      (this.identity?.dexComplete ?? false) &&
        this.visitsEnabled &&
        this.residentEnabled &&
        !this.dismissed,
    );
    // Losing an empty floor is immediate: never animate back through newly
    // entered text, an attachment, or a newly widened footer control.
    if (
      ((!this.floorEnabled || !this.geometry.scene.floor) && this.anchor === "floor") ||
      (this.travel && this.travelScene !== this.geometry.scene)
    ) {
      this.clearActTimers();
      this.act = null;
      this.anchor = "top";
      this.restartPending = this.presence === "in";
    }
    this.host.setAttribute("data-spot", this.anchor);
    this.host.toggleAttribute("data-floor-enabled", this.floorEnabled);
    this.reconcilePresence();
    this.traffic.update();
  }

  // Reconcile in the update pass to avoid chaining post-update state changes.
  private reconcilePresence() {
    const visible = this.wantsVisible();
    if (visible && this.presence !== "in") {
      this.timers.clear("leaveTimer");
      if (this.presence === "out") {
        this.rollPerch();
        // Entrance rolls burn once per arrival on their own stream, aligned
        // across scheduled visits and offline summons.
        this.entrance = plans.pickLobsterEntrance(this.entranceRng());
        if (this.look) {
          // Anniversary check reads the dex before this arrival records into
          // it: a first-ever visit today must not celebrate itself.
          this.anniversary = dex.isLobsterFirstVisitAnniversary(
            dex.getLobsterdexEntries().get(this.look.palette.id)?.firstSeenAt ?? null,
            new Date(),
          );
          dex.recordLobsterVisit(this.look.palette.id, {
            name: this.identity
              ? plans.lobsterLoadDisplayName(this.identity, this.seed)
              : lobsterLook.lobsterPetName(this.look, this.seed),
            shiny: this.look.shiny,
          });
          dex.recordLobsterArrivalStats();
        }
      }
      this.presence = "in";
      this.entering = !plans.prefersReducedMotion();
      this.restartPending = true;
      return;
    }
    if (!visible && this.presence === "in") {
      this.dismissMenuPosition = null;
      this.outcomePresenceOwner = null;
      this.clearActTimers();
      this.act = null;
      this.entering = false;
      this.presence = "leaving";
      this.timers.schedule("leaveTimer", plans.LEAVE_MS, () => {
        this.presence = "out";
      });
    }
  }

  afterCommit() {
    if (!this.active || !this.restartPending) {
      return;
    }
    this.restartPending = false;
    this.timers.schedule("enterTimer", plans.LOBSTER_PET_ENTRANCE_MS[this.entrance], () => {
      this.entering = false;
      if (
        !this.greetedThisLoad &&
        (this.familiarity.tier === "friend" || this.identity?.oldFriend === true) &&
        this.presence === "in" &&
        !plans.prefersReducedMotion()
      ) {
        this.greetedThisLoad = true;
        this.performAct("wave");
      }
    });
    this.scheduleNextAct();
  }

  private readonly handleVisibilityChange = () => {
    if (document.hidden) {
      this.outcomePresenceOwner = null;
      this.clearActTimers();
      this.act = null;
    } else {
      this.scheduleNextAct();
    }
    this.refresh();
  };

  private trackVigil() {
    this.timers.clear("vigilTimer");
    if (this.mode === "busy" && this.visitsEnabled && this.residentEnabled && !this.dismissed) {
      this.timers.schedule("vigilTimer", 600_000, () => {
        this.vigil = true;
        this.clearActTimers();
        this.act = null;
      });
    } else {
      this.vigil = false;
    }
  }

  private readonly openDismissMenu = (event: MouseEvent) => {
    if (!this.residentEnabled || !this.visitsEnabled) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.interactions.handleHoldCancel();
    this.dismissMenuPosition = { x: event.clientX, y: event.clientY };
    this.refresh();
  };

  dismiss(permanently: boolean) {
    this.dismissMenuPosition = null;
    this.dismissed = true;
    dex.recordLobsterShoo();
    if (permanently) {
      this.visitsEnabled = false;
      this.disableVisits();
      patchSettings({ lobsterPetVisits: false });
      this.onVisitsDisabled();
    }
    this.refresh();
  }

  private clearActTimers() {
    this.travel = null;
    this.timers.clear("idleTimer", "actEndTimer", "enterTimer");
  }

  private suspendResident() {
    this.clearActTimers();
    this.timers.clear("visitTimer", "leaveTimer");
    this.interactions.suspend();
    this.timers.clear("shellTimer", "vigilTimer");
    this.shellVisible = false;
    this.vigil = false;
    this.outcomePresenceOwner = null;
    this.dismissMenuPosition = null;
    this.scheduledVisiting = false;
    this.presence = "out";
    this.act = null;
    this.entering = false;
    this.restartPending = false;
  }

  private scheduleVisits() {
    this.timers.clear("visitTimer", "leaveTimer");
    this.scheduledVisiting = false;
    if (!this.visitsEnabled || !this.residentEnabled) {
      return;
    }
    // A shy share of loads never visits on their own; offline still summons.
    if (this.visitRng() < plans.VISIT_SHY_CHANCE) {
      return;
    }
    const tuning = dex.LOBSTER_FAMILIARITY_TUNING[this.familiarity.tier];
    this.armArrival(
      lobsterLook.randomBetween(
        this.visitRng,
        plans.VISIT_FIRST_DELAY_MS[0],
        plans.VISIT_FIRST_DELAY_MS[1],
      ) * tuning.firstDelayMul,
    );
  }

  private armArrival(delayMs: number) {
    if (!this.active || !this.visitsEnabled || !this.residentEnabled) {
      return;
    }
    this.timers.schedule("visitTimer", delayMs, () => {
      this.scheduledVisiting = true;
      this.armDeparture(
        lobsterLook.randomBetween(this.visitRng, plans.VISIT_STAY_MS[0], plans.VISIT_STAY_MS[1]) *
          dex.LOBSTER_FAMILIARITY_TUNING[this.familiarity.tier].stayMul,
      );
    });
  }

  private armDeparture(stayMs: number) {
    this.timers.schedule("visitTimer", stayMs, () => {
      this.scheduledVisiting = false;
      const tuning = dex.LOBSTER_FAMILIARITY_TUNING[this.familiarity.tier];
      const waryMul = this.familiarity.wary ? dex.LOBSTER_FAMILIARITY_TUNING.waryGapMul : 1;
      this.armArrival(
        lobsterLook.randomBetween(this.visitRng, plans.VISIT_GAP_MS[0], plans.VISIT_GAP_MS[1]) *
          tuning.gapMul *
          waryMul,
      );
    });
  }

  // Scuttle owns facing while walking; other acts can watch passing traffic.
  private watchTraffic(facing: 1 | -1) {
    if (this.presence === "in" && this.act !== "scuttle" && !this.vigil) {
      this.facing = facing;
    }
  }

  private reactToPasser() {
    const reaction =
      this.familiarity.tier === "friend" ? "wave" : this.familiarity.tier === "shy" ? "peek" : null;
    if (
      reaction === null ||
      this.presence !== "in" ||
      this.act !== null ||
      this.vigil ||
      this.mode !== "idle" ||
      plans.prefersReducedMotion()
    ) {
      return;
    }
    this.performAct(reaction);
  }

  private rollPerch() {
    this.anchor = "top";
    this.spotPct = Math.round(lobsterLook.randomBetween(this.visitRng, 12, 88));
    this.facing = this.visitRng() < 0.5 ? 1 : -1;
  }

  private scheduleNextAct() {
    // Guard here, not just at activation: the visibilitychange resume path
    // must also stay inert for reduced-motion users and departed pets.
    if (
      !this.active ||
      !this.visitsEnabled ||
      !this.residentEnabled ||
      !this.look ||
      this.presence !== "in" ||
      this.vigil ||
      this.traffic.passer !== null ||
      this.timers.has("idleTimer") ||
      this.timers.has("actEndTimer") ||
      plans.prefersReducedMotion()
    ) {
      return;
    }
    const profile = plans.resolveLobsterActProfile(this.mode, this.look.personality);
    if (!profile) {
      return;
    }
    const delay = lobsterLook.randomBetween(this.rng, profile.delayMs[0], profile.delayMs[1]);
    this.timers.schedule("idleTimer", delay, () => {
      const nextProfile = plans.resolveLobsterActProfile(this.mode, this.look?.personality ?? null);
      // A crossing pauses the fidget loop: the pet is busy watching. The
      // traffic controller's passer-end hook restarts scheduling.
      if (
        !nextProfile ||
        document.hidden ||
        this.presence !== "in" ||
        this.traffic.passer !== null
      ) {
        return;
      }
      if (this.moltPlanned && !this.molted && this.mode === "idle") {
        this.performAct("molt");
        return;
      }
      this.performAct(lobsterLook.pickWeighted(this.rng, nextProfile.acts));
    });
  }

  private performAct(act: plans.LobsterPetAct, presenceOwner: "vigil" | null = null) {
    if (!this.visitsEnabled || !this.residentEnabled || this.presence !== "in") {
      return;
    }
    this.clearActTimers();
    // The active outcome chain carries its sole presence owner across linked
    // acts; overrides, forced departures, and the terminal act release it.
    this.outcomePresenceOwner = presenceOwner;
    this.entering = false;
    if (act === "hop") {
      this.startFloorHop();
    } else if (act === "scuttle") {
      this.applyMove(this.geometry.planWalk(this.anchor, this.spotPct, this.rng()));
    }
    const duration = this.travel
      ? lobsterTravelDuration(this.travel)
      : plans.LOBSTER_PET_ACT_DURATION_MS[act];
    this.act = this.travel && !this.travel.hop ? "scuttle" : act;
    this.timers.schedule("actEndTimer", duration + (this.twinPlanned ? 180 : 0), () => {
      this.act = null;
      this.travel = null;
      if (act === "molt") {
        this.completeMolt();
      }
      if (act === "droop") {
        this.performAct("sweep", presenceOwner);
        return;
      }
      this.outcomePresenceOwner = null;
      if (this.wantsVisible()) {
        this.scheduleNextAct();
      }
    });
  }

  private completeMolt() {
    this.molted = true;
    if (this.look) {
      // The shed shell keeps the true pre-molt size; a max-tier pet sheds a
      // max-tier shell.
      this.shellScale = this.look.scale;
      this.look = {
        ...this.look,
        scale: this.look.scale < 2 ? 2 : 2.5,
      };
    }
    this.shellSpotPct = this.spotPct;
    this.shellAnchor = this.anchor;
    this.shellVisible = true;
    this.spotPct = Math.min(100, Math.max(0, this.spotPct + this.facing * 9));
    this.timers.clear("shellTimer");
    this.timers.schedule("shellTimer", 60_000, () => {
      this.shellVisible = false;
    });
  }

  private applyMove(move: LobsterSceneMove | null) {
    if (!move) {
      return;
    }
    this.anchor = move.anchor;
    this.spotPct = move.spotPct;
    this.facing = move.facing;
    this.travel = move.travel;
    this.travelScene = this.geometry.scene;
  }

  private startFloorHop() {
    if (
      !this.floorEnabled ||
      this.identity?.elder ||
      (this.anchor === "top" && this.motionRng() >= 0.45)
    ) {
      return;
    }
    this.applyMove(this.geometry.planHop(this.anchor, this.spotPct));
  }

  scene(): LobsterPetSceneProps | null {
    const look = this.look;
    if (!look) {
      return null;
    }
    const identity = this.identity;
    const flavor = identity?.elder
      ? "old as the tides"
      : identity?.oldFriend
        ? "an old friend"
        : null;
    return {
      look,
      mode: this.mode,
      presence: this.presence,
      shellVisible: this.shellVisible,
      shellAnchor: this.shellAnchor,
      scene: this.geometry.scene,
      travel: this.travel,
      floorEnabled: this.floorEnabled,
      visitsEnabled: this.visitsEnabled,
      residentEnabled: this.residentEnabled,
      critterArtwork: this.critterArtwork,
      dismissed: this.dismissed,
      passer: this.traffic.passer
        ? {
            kind: this.traffic.passer.kind,
            direction: this.traffic.passer.direction,
            crossMs: this.traffic.passerCrossMs(),
            anchor: this.passerAnchor,
            hops: this.passerHops,
          }
        : null,
      twinPlanned: this.twinPlanned,
      anniversary: this.anniversary,
      entering: this.entering,
      entrance: this.entrance,
      grumpy: this.grumpy,
      vigil: this.vigil,
      elder: identity?.elder ?? false,
      act: this.act,
      spotPct: this.spotPct,
      facing: this.facing,
      anchor: this.anchor,
      shellScale: this.shellScale,
      shellSpotPct: this.shellSpotPct,
      familiarityVisits: this.familiarity.visits,
      seed: this.seed,
      movingDay: this.movingDay,
      sailorDay: this.sailorDay,
      nameOverride: identity ? plans.lobsterLoadDisplayName(identity, this.seed) : null,
      flavor,
      bottle: this.traffic.bottle,
      onPointerDown: this.interactions.handleHoldStart,
      onPointerUp: this.interactions.handleHoldEnd,
      onPointerCancel: this.interactions.handleHoldCancel,
      onContextMenu: this.openDismissMenu,
      onBottleOpen: this.traffic.openBottle,
    };
  }

  menuPosition() {
    return this.dismissMenuPosition;
  }

  closeMenu() {
    this.dismissMenuPosition = null;
    this.refresh();
  }
}
