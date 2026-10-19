import { isLobsterDay } from "../../../src/shared/lobster-day.js";
import { patchSettings } from "../app/settings.ts";
import { listen } from "../lib/reactive/listener.ts";
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

/** Synchronous animation owner; Solid only observes committed scene snapshots. */
export class LobsterPetOwner {
  private act: plans.LobsterPetAct | null = null;
  private spotPct = 80;
  private facing: 1 | -1 = 1;
  private entering = false;
  private entrance: contract.LobsterPetEntrance = "walk";
  private presence: "out" | "in" | "leaving" = "out";
  private anchor: plans.LobsterPetAnchor = "top";
  private readonly geometry = new LobsterComposerGeometry(
    this.host,
    () => this.host.composerElements?.() ?? null,
    () => this.inputs.residentEnabled && this.twinPlanned,
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
    visitsEnabled: () => this.inputs.visitsEnabled && !this.dismissed,
    passerOptions: () => ({
      critters: this.inputs.critters,
      strangers: this.inputs.residentEnabled,
      critterArtwork: this.inputs.critterArtwork,
    }),
    onPasserStart: (plan) => {
      this.passerAnchor =
        plan.floor && this.inputs.floorEnabled && this.geometry.scene.floor ? "floor" : "top";
      this.passerHops =
        this.passerAnchor === "floor" && plan.hops && this.geometry.scene.passage !== null;
    },
    onPasserFacing: (facing) => this.watchTraffic(facing),
    onPasserMidCross: () => this.reactToPasser(),
    onPasserDone: () => this.scheduleNextAct(),
  });
  private readonly interactions = new LobsterPetInteractions({
    soundsEnabled: () => this.inputs.soundsEnabled,
    canHuff: () => this.inputs.mode !== "offline",
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
  private stopVisibility?: () => void;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly host: HTMLElement & Pick<contract.LobsterPetProps, "composerElements">,
    private readonly disableVisits: () => void,
    private inputs: Readonly<contract.LobsterPetProps>,
  ) {}

  connect() {
    this.look = null;
    this.active = true;
    this.geometry.connect();
    this.traffic.connect();
    this.interactions.connect();
    this.stopVisibility = listen(document, "visibilitychange", this.handleVisibilityChange);
  }

  dispose() {
    this.active = false;
    this.stopVisibility?.();
    this.stopVisibility = undefined;
    this.clearActTimers();
    this.restartPending = false;
    this.scheduledVisiting = false;
    this.presence = "out";
    this.act = null;
    this.timers.clear("visitTimer", "leaveTimer", "shellTimer", "vigilTimer");
    this.geometry.dispose();
    this.traffic.dispose();
    this.interactions.dispose();
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  update(props: contract.LobsterPetProps) {
    const previous = this.inputs;
    this.inputs = props;
    this.reconcile(previous);
    if (this.active) {
      this.publish();
    }
  }

  private refresh() {
    if (!this.active) {
      return;
    }
    this.reconcile();
    this.publish();
  }

  private wantsVisible(): boolean {
    return (
      this.inputs.visitsEnabled &&
      this.inputs.residentEnabled &&
      !this.dismissed &&
      (this.inputs.mode === "offline" ||
        this.vigil ||
        this.outcomePresenceOwner !== null ||
        this.scheduledVisiting)
    );
  }

  private reconcile(previous = this.inputs) {
    if (!this.active) {
      return;
    }
    const seedChanged = this.look === null || !Object.is(previous.seed, this.inputs.seed);
    if (seedChanged) {
      this.look = lobsterLook.createLobsterPetLook(this.inputs.seed);
      this.rng = lobsterLook.mulberry32(this.inputs.seed ^ 0x9e3779b9);
      this.motionRng = lobsterLook.mulberry32(this.inputs.seed ^ 0xf1002);
      this.visitRng = lobsterLook.mulberry32(this.inputs.seed ^ 0x5eaf00d);
      this.entranceRng = lobsterLook.mulberry32((this.inputs.seed ^ 0xe27a) >>> 0);
      this.identity = plans.resolveLobsterLoadIdentity(this.inputs.seed, this.look);
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
      this.moltPlanned = plans.isLobsterMoltLoad(this.inputs.seed) && !this.identity.elder;
      this.twinPlanned = plans.isLobsterTwinLoad(this.inputs.seed);
      this.geometry.scheduleMeasure();
      this.familiarity = dex.getLobsterFamiliarity();
      this.sailorDay = isLobsterDay(new Date());
      this.greetedThisLoad = false;
      this.scheduleVisits();
      this.traffic.reset(this.inputs.seed);
      // The first update takes this branch, so the mode-change branch below
      // never sees the initial mode: arm the vigil tracker here as well.
      this.vigil = false;
      this.outcomePresenceOwner = null;
      this.trackVigil();
    } else if (previous.mode !== this.inputs.mode) {
      const finished = previous.mode === "busy" && this.inputs.mode === "idle";
      const presenceOwner = finished && this.vigil ? "vigil" : null;
      this.trackVigil();
      if (this.presence === "in" && !plans.prefersReducedMotion()) {
        const finishAct = plans.resolveLobsterFinishAct(this.inputs.runOutcome);
        this.performAct(finished ? finishAct : "startle", presenceOwner);
      }
    }
    if (
      previous.visitsEnabled !== this.inputs.visitsEnabled ||
      previous.residentEnabled !== this.inputs.residentEnabled
    ) {
      if (this.inputs.visitsEnabled && !previous.visitsEnabled) {
        this.dismissed = false;
        this.traffic.reset(this.inputs.seed);
      }
      if (!this.inputs.visitsEnabled || !this.inputs.residentEnabled) {
        this.suspendResident();
      } else if (!previous.visitsEnabled || !previous.residentEnabled) {
        this.scheduleVisits();
        this.trackVigil();
      }
    }
    const previousCritters = previous.critters ?? [];
    const critters = this.inputs.critters ?? [];
    const crittersChanged =
      previous.critters !== this.inputs.critters &&
      (previousCritters.length !== critters.length ||
        previousCritters.some((kind, index) => kind !== critters[index]));
    if (
      !seedChanged &&
      (previous.residentEnabled !== this.inputs.residentEnabled || crittersChanged)
    ) {
      this.traffic.replanPasser(this.inputs.seed);
      this.geometry.scheduleMeasure();
    }
    // A theme without the resident leaves its upgrade marker for a later visit.
    if (this.inputs.residentEnabled && !this.movingDayChecked && this.inputs.gatewayVersion) {
      this.movingDayChecked = true;
      this.movingDay = plans.detectLobsterMovingDay(this.inputs.gatewayVersion);
    }
    // The completed-Lobsterdex trim lives on the host so it survives the pet
    // being out; the visits setting and dismissals silence it too.
    this.host.toggleAttribute(
      "data-dex-complete",
      (this.identity?.dexComplete ?? false) &&
        this.inputs.visitsEnabled &&
        this.inputs.residentEnabled &&
        !this.dismissed,
    );
    // Losing an empty floor is immediate: never animate back through newly
    // entered text, an attachment, or a newly widened footer control.
    if (
      ((!this.inputs.floorEnabled || !this.geometry.scene.floor) && this.anchor === "floor") ||
      (this.travel && this.travelScene !== this.geometry.scene)
    ) {
      this.clearActTimers();
      this.act = null;
      this.anchor = "top";
      this.restartPending = this.presence === "in";
    }
    this.host.setAttribute("data-spot", this.anchor);
    this.host.toggleAttribute("data-floor-enabled", this.inputs.floorEnabled);
    this.reconcilePresence();
    this.traffic.update();
    this.startPendingActs();
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
              ? plans.lobsterLoadDisplayName(this.identity, this.inputs.seed)
              : lobsterLook.lobsterPetName(this.look, this.inputs.seed),
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

  private startPendingActs() {
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
    if (
      this.inputs.mode === "busy" &&
      this.inputs.visitsEnabled &&
      this.inputs.residentEnabled &&
      !this.dismissed
    ) {
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
    if (!this.inputs.residentEnabled || !this.inputs.visitsEnabled) {
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
      this.inputs = { ...this.inputs, visitsEnabled: false };
      this.disableVisits();
      patchSettings({ lobsterPetVisits: false });
      this.inputs.onVisitsDisabled();
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
    if (!this.inputs.visitsEnabled || !this.inputs.residentEnabled) {
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
    if (!this.active || !this.inputs.visitsEnabled || !this.inputs.residentEnabled) {
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
      this.inputs.mode !== "idle" ||
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
      !this.inputs.visitsEnabled ||
      !this.inputs.residentEnabled ||
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
    const profile = plans.resolveLobsterActProfile(this.inputs.mode, this.look.personality);
    if (!profile) {
      return;
    }
    const delay = lobsterLook.randomBetween(this.rng, profile.delayMs[0], profile.delayMs[1]);
    this.timers.schedule("idleTimer", delay, () => {
      const nextProfile = plans.resolveLobsterActProfile(
        this.inputs.mode,
        this.look?.personality ?? null,
      );
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
      if (this.moltPlanned && !this.molted && this.inputs.mode === "idle") {
        this.performAct("molt");
        return;
      }
      this.performAct(lobsterLook.pickWeighted(this.rng, nextProfile.acts));
    });
  }

  private performAct(act: plans.LobsterPetAct, presenceOwner: "vigil" | null = null) {
    if (!this.inputs.visitsEnabled || !this.inputs.residentEnabled || this.presence !== "in") {
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
      !this.inputs.floorEnabled ||
      this.identity?.elder ||
      (this.anchor === "top" && this.motionRng() >= 0.45)
    ) {
      return;
    }
    this.applyMove(this.geometry.planHop(this.anchor, this.spotPct));
  }

  private scene(): LobsterPetSceneProps | null {
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
      mode: this.inputs.mode,
      presence: this.presence,
      shellVisible: this.shellVisible,
      shellAnchor: this.shellAnchor,
      scene: this.geometry.scene,
      travel: this.travel,
      floorEnabled: this.inputs.floorEnabled,
      visitsEnabled: this.inputs.visitsEnabled,
      residentEnabled: this.inputs.residentEnabled,
      critterArtwork: this.inputs.critterArtwork,
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
      seed: this.inputs.seed,
      movingDay: this.movingDay,
      sailorDay: this.sailorDay,
      nameOverride: identity ? plans.lobsterLoadDisplayName(identity, this.inputs.seed) : null,
      flavor,
      bottle: this.traffic.bottle,
      onPointerDown: this.interactions.handleHoldStart,
      onSprite: this.interactions.bindSprite,
      onPointerUp: this.interactions.handleHoldEnd,
      onPointerCancel: this.interactions.handleHoldCancel,
      onContextMenu: this.openDismissMenu,
      onBottleOpen: this.traffic.openBottle,
    };
  }

  snapshot() {
    return { scene: this.scene(), menuPosition: this.dismissMenuPosition };
  }

  closeMenu() {
    this.dismissMenuPosition = null;
    this.refresh();
  }
}
