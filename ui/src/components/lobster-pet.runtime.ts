// Decorative critter visitor that perches on the new-session composer and mirrors
// gateway status: it idles (naps, waves, wanders) when nothing is running,
// scurries while runs are active, and paces worriedly while disconnected.
// Drawn in the smooth OpenClaw lobster style (see the dreams scene and
// icons.lobster). Look and personality are seeded per session + page load so
// every new session hatches a slightly different lobster.
import { LitElement, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { ThemeArtwork } from "../../../packages/gateway-protocol/src/theme.ts";
import { isLobsterDay } from "../../../src/shared/lobster-day.js";
import { patchSettings } from "../app/settings.ts";
import * as dex from "./lobster-dex.ts";
import * as contract from "./lobster-pet-contract.ts";
import {
  renderLobsterPetDismissMenu,
  type LobsterPetDismissMenuPosition,
} from "./lobster-pet-dismiss-menu.ts";
import { LobsterPetInteractions } from "./lobster-pet-interactions.ts";
import * as lobsterLook from "./lobster-pet-look.ts";
import * as plans from "./lobster-pet-plans.ts";
import { renderLobsterPetScene } from "./lobster-pet-scene-view.ts";
import {
  LobsterComposerGeometry,
  lobsterTravelDuration,
  type LobsterSceneTravel,
  type LobsterSceneMove,
} from "./lobster-pet-scene.ts";
import { LobsterLedgeTraffic } from "./lobster-pet-traffic.ts";

class LobsterPet extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) seed = 0;
  @property({ attribute: false }) mode: contract.LobsterPetMode = "idle";

  @property({ attribute: false }) visitsEnabled = true;
  @property({ attribute: false }) residentEnabled = true;
  @property({ attribute: false }) critters: readonly string[] | undefined;
  @property({ attribute: false }) critterArtwork: ThemeArtwork["critters"];
  @property({ attribute: false }) floorEnabled = false;
  @property({ attribute: false }) runOutcome: contract.LobsterRunOutcome = "ok";
  @property({ attribute: false }) soundsEnabled = false;
  @property({ attribute: false }) gatewayVersion: string | null = null;
  @property({ attribute: false }) onVisitsDisabled: () => void = () => undefined;

  @state() private act: plans.LobsterPetAct | null = null;
  @state() private spotPct = 80;
  @state() private facing: 1 | -1 = 1;
  @state() private entering = false;
  @state() private entrance: contract.LobsterPetEntrance = "walk";
  @state() private presence: "out" | "in" | "leaving" = "out";
  @state() private anchor: plans.LobsterPetAnchor = "top";
  private readonly geometry = new LobsterComposerGeometry(
    this,
    () => this.residentEnabled && this.twinPlanned,
  );
  private travel: LobsterSceneTravel | null = null;
  private travelScene = this.geometry.scene;
  private motionRng: () => number = lobsterLook.mulberry32(0);
  private passerAnchor: plans.LobsterPetAnchor = "top";
  private passerHops = false;
  private shellAnchor: plans.LobsterPetAnchor = "top";
  @state() private scheduledVisiting = false;
  @state() private dismissed = false;
  @state() private dismissMenuPosition: LobsterPetDismissMenuPosition | null = null;
  @state() private grumpy = false;
  @state() private vigil = false;
  @state() private outcomePresenceOwner: "vigil" | null = null;
  @state() private movingDay = false;
  private movingDayChecked = false;
  @state() private anniversary = false;
  private sailorDay = false;
  // Rare-load identity resolved once per seed (Elder, old-friend returns,
  // Lobsterdex completion) - a load-start snapshot, like familiarity.
  private identity: plans.LobsterLoadIdentity | null = null;
  private entranceRng: () => number = lobsterLook.mulberry32(0);
  // Passers and the bottle run on their own clocks beside the resident.
  private readonly traffic = new LobsterLedgeTraffic(this, {
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
  private readonly interactions = new LobsterPetInteractions(this, {
    soundsEnabled: () => this.soundsEnabled,
    canHuff: () => this.mode !== "offline",
    canGaze: () => this.presence === "in" && this.act === null && !this.vigil,
    onGrumpyChange: (grumpy) => {
      this.grumpy = grumpy;
    },
    onAct: (act) => this.performAct(act),
    onFacing: (facing) => {
      this.facing = facing;
    },
    onHuff: () => {
      this.clearVisitTimers();
      this.scheduledVisiting = false;
      this.armArrival(
        lobsterLook.randomBetween(this.visitRng, plans.VISIT_GAP_MS[0], plans.VISIT_GAP_MS[1]),
      );
    },
  });
  @state() private shellVisible = false;
  private shellSpotPct = 50;
  private shellScale = 2;
  private molted = false;
  private moltPlanned = false;
  private twinPlanned = false;
  private shellTimer: number | null = null;
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
  private idleTimer: number | null = null;
  private actEndTimer: number | null = null;
  private enterTimer: number | null = null;
  private visitTimer: number | null = null;
  private leaveTimer: number | null = null;
  private vigilTimer: number | null = null;
  private restartPending = false;

  override connectedCallback() {
    super.connectedCallback();
    if (this.hasUpdated) {
      this.look = null;
      this.requestUpdate();
    }
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
  }

  override disconnectedCallback() {
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.clearActTimers();
    this.clearVisitTimers();
    this.restartPending = false;
    this.scheduledVisiting = false;
    this.presence = "out";
    this.act = null;
    this.travel = null;
    if (this.shellTimer !== null) {
      window.clearTimeout(this.shellTimer);
      this.shellTimer = null;
    }
    if (this.vigilTimer !== null) {
      window.clearTimeout(this.vigilTimer);
      this.vigilTimer = null;
    }
    super.disconnectedCallback();
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

  override willUpdate(changed: PropertyValues<this>) {
    if (!this.isConnected) {
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
      // Reset the act loop inside the update pass; deferring state flips to
      // updated() would chain a second update and trip lit's change-in-update
      // warning.
      this.clearActTimers();
      this.act = null;
      this.dismissed = false;
      this.dismissMenuPosition = null;
      this.presence = "out";
      this.molted = false;
      this.shellVisible = false;
      if (this.shellTimer !== null) {
        window.clearTimeout(this.shellTimer);
        this.shellTimer = null;
      }
      // The Elder never molts: it is already every size it will ever need.
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
        // Status flips get an immediate reaction. A finished run (busy ->
        // idle) earns a cheer when it succeeded and a sympathetic droop when
        // it failed; everything else startles. The act-end timer then
        // reschedules from the new mode's pool.
        // Success cheers, failure droops, a user abort is nothing to
        // celebrate or mourn - just acknowledge the change.
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
    const previousCritters = changed.get("critters") ?? [];
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
    this.toggleAttribute(
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
      this.travel = null;
      this.anchor = "top";
      this.restartPending = this.presence === "in";
    }
    this.setAttribute("data-spot", this.anchor);
    this.toggleAttribute("data-floor-enabled", this.floorEnabled);
    this.reconcilePresence();
  }

  // Presence follows the visit schedule, offline summons, the setting, and
  // dismissals. Runs inside the update pass so arrivals/departures never
  // chain a post-update state change.
  private reconcilePresence() {
    const visible = this.wantsVisible();
    if (visible && this.presence !== "in") {
      if (this.leaveTimer !== null) {
        window.clearTimeout(this.leaveTimer);
        this.leaveTimer = null;
      }
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
          // Every genuine arrival (visit or offline summon) logs the palette
          // with the first visitor's name (the Elder signs as itself) and
          // any shiny sighting, and bumps the familiarity count.
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
      this.leaveTimer = window.setTimeout(() => {
        this.leaveTimer = null;
        this.presence = "out";
      }, plans.LEAVE_MS);
    }
  }

  override updated() {
    if (!this.isConnected || !this.restartPending) {
      return;
    }
    this.restartPending = false;
    this.enterTimer = window.setTimeout(() => {
      this.enterTimer = null;
      this.entering = false;
      // Familiar humans and returning old friends get a hello on the first
      // arrival of the load.
      if (
        !this.greetedThisLoad &&
        (this.familiarity.tier === "friend" || this.identity?.oldFriend === true) &&
        this.presence === "in" &&
        !plans.prefersReducedMotion()
      ) {
        this.greetedThisLoad = true;
        this.performAct("wave");
      }
    }, plans.LOBSTER_PET_ENTRANCE_MS[this.entrance]);
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
  };

  // Long runs earn solidarity: after 10 minutes of busy the pet settles
  // into a quiet waiting pose until the run ends.
  private trackVigil() {
    if (this.vigilTimer !== null) {
      window.clearTimeout(this.vigilTimer);
      this.vigilTimer = null;
    }
    if (this.mode === "busy" && this.visitsEnabled && this.residentEnabled && !this.dismissed) {
      this.vigilTimer = window.setTimeout(() => {
        this.vigilTimer = null;
        this.vigil = true;
        this.clearActTimers();
        this.act = null;
      }, 600_000);
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
  };

  private dismiss(permanently: boolean) {
    this.dismissMenuPosition = null;
    this.dismissed = true;
    dex.recordLobsterShoo();
    if (permanently) {
      this.visitsEnabled = false;
      patchSettings({ lobsterPetVisits: false });
      this.onVisitsDisabled();
    }
  }

  private clearActTimers() {
    this.travel = null;
    for (const timer of [this.idleTimer, this.actEndTimer, this.enterTimer]) {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    }
    this.idleTimer = null;
    this.actEndTimer = null;
    this.enterTimer = null;
  }

  private clearVisitTimers() {
    for (const timer of [this.visitTimer, this.leaveTimer]) {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    }
    this.visitTimer = null;
    this.leaveTimer = null;
  }

  private suspendResident() {
    this.clearActTimers();
    this.clearVisitTimers();
    this.interactions.suspend();
    for (const timer of [this.shellTimer, this.vigilTimer]) {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    }
    this.shellTimer = null;
    this.vigilTimer = null;
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

  // ---- Visit schedule ----

  private scheduleVisits() {
    this.clearVisitTimers();
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
    if (!this.isConnected || !this.visitsEnabled || !this.residentEnabled) {
      return;
    }
    this.visitTimer = window.setTimeout(() => {
      this.visitTimer = null;
      this.scheduledVisiting = true;
      this.armDeparture(
        lobsterLook.randomBetween(this.visitRng, plans.VISIT_STAY_MS[0], plans.VISIT_STAY_MS[1]) *
          dex.LOBSTER_FAMILIARITY_TUNING[this.familiarity.tier].stayMul,
      );
    }, delayMs);
  }

  private armDeparture(stayMs: number) {
    this.visitTimer = window.setTimeout(() => {
      this.visitTimer = null;
      this.scheduledVisiting = false;
      const tuning = dex.LOBSTER_FAMILIARITY_TUNING[this.familiarity.tier];
      const waryMul = this.familiarity.wary ? dex.LOBSTER_FAMILIARITY_TUNING.waryGapMul : 1;
      this.armArrival(
        lobsterLook.randomBetween(this.visitRng, plans.VISIT_GAP_MS[0], plans.VISIT_GAP_MS[1]) *
          tuning.gapMul *
          waryMul,
      );
    }, stayMs);
  }

  // ---- Ledge traffic (scheduling lives in LobsterLedgeTraffic) ----

  // The resident notices traffic: it turns toward a passer's entry side,
  // then follows it out with a mid-crossing flip. Scuttle owns facing while
  // it walks; anything else can turn its head.
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
      !this.isConnected ||
      !this.visitsEnabled ||
      !this.residentEnabled ||
      !this.look ||
      this.presence !== "in" ||
      this.vigil ||
      this.traffic.passer !== null ||
      this.idleTimer !== null ||
      this.actEndTimer !== null ||
      plans.prefersReducedMotion()
    ) {
      return;
    }
    const profile = plans.resolveLobsterActProfile(this.mode, this.look.personality);
    if (!profile) {
      return;
    }
    const delay = lobsterLook.randomBetween(this.rng, profile.delayMs[0], profile.delayMs[1]);
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = null;
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
    }, delay);
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
      this.startScuttle();
    }
    const duration = this.travel
      ? lobsterTravelDuration(this.travel)
      : plans.LOBSTER_PET_ACT_DURATION_MS[act];
    this.act = this.travel && !this.travel.hop ? "scuttle" : act;
    this.actEndTimer = window.setTimeout(
      () => {
        this.actEndTimer = null;
        this.act = null;
        this.travel = null;
        if (act === "molt") {
          this.completeMolt();
        }
        if (act === "droop") {
          // Bad news gets processed lobster-style: tidy the ledge, then move on.
          this.performAct("sweep", presenceOwner);
          return;
        }
        this.outcomePresenceOwner = null;
        if (this.wantsVisible()) {
          this.scheduleNextAct();
        }
      },
      duration + (this.twinPlanned ? 180 : 0),
    );
  }

  // Shedding: the old shell stays behind and slowly fades while the pet
  // steps aside one size bigger. Once per load.
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
    if (this.shellTimer !== null) {
      window.clearTimeout(this.shellTimer);
    }
    this.shellTimer = window.setTimeout(() => {
      this.shellTimer = null;
      this.shellVisible = false;
    }, 60_000);
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

  private startScuttle() {
    this.applyMove(this.geometry.planWalk(this.anchor, this.spotPct, this.rng()));
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

  override render() {
    const look = this.look;
    if (!look) {
      return nothing;
    }
    const identity = this.identity;
    const flavor = identity?.elder
      ? "old as the tides"
      : identity?.oldFriend
        ? "an old friend"
        : null;
    const scene = renderLobsterPetScene({
      look,
      mode: this.mode,
      presence: this.presence,
      shellVisible:
        this.shellVisible &&
        (this.shellAnchor === "top" || (this.floorEnabled && this.geometry.scene.floor !== null)),
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
      bottle: this.traffic.bottle(),
      onPointerDown: this.interactions.handleHoldStart,
      onPointerUp: this.interactions.handleHoldEnd,
      onPointerCancel: this.interactions.handleHoldCancel,
      onContextMenu: this.openDismissMenu,
      onBottleOpen: this.traffic.openBottle,
    });
    return [
      scene,
      renderLobsterPetDismissMenu({
        position: this.dismissMenuPosition,
        onDismiss: (permanently) => this.dismiss(permanently),
        onClose: () => {
          this.dismissMenuPosition = null;
        },
      }),
    ];
  }
}
if (!customElements.get("openclaw-lobster-pet")) {
  customElements.define("openclaw-lobster-pet", LobsterPet);
}
