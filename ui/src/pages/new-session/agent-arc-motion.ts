// Motion for the agents arc around the new-session avatar. Every face is a small
// spring-driven mass; nothing here is a timed CSS transition.

type Pose = { x: number; y: number; s: number; o: number };
type Mode = "open" | "close" | "turn" | "exit" | "live";
type Spring = { k: number; c: number };
type Face = {
  el: HTMLElement;
  i: number;
  off: number;
  p: Pose;
  v: Pose;
  base: Pose;
  mode: Mode;
  next: Pose | null;
  nextMode: Mode;
  at: number;
};

const KEYS = ["x", "y", "s", "o"] as const;
/** Pointer seats, for the 96px avatar: x, y, scale and opacity by distance from the current agent. */
const HOVER_AVATAR = 96;
const SEATS = { 1: [94, 8, 56 / 96, 0.58], 2: [156, 24, 40 / 96, 0.3] } as const;
/** Touch seats, for the 56px phone avatar: one neighbour on each side. */
const TOUCH_AVATAR = 56;
const NEIGHBOUR_SCALE = 34 / 56;
const SPRINGS: Record<Mode, Spring> = {
  open: { k: 300, c: 30 },
  close: { k: 380, c: 40 },
  turn: { k: 170, c: 24 },
  exit: { k: 200, c: 27 },
  live: { k: 380, c: 39 },
};
const zero = (): Pose => ({ x: 0, y: 0, s: 0, o: 0 });

export type AgentArcMotionOptions = {
  root: HTMLElement;
  tip: HTMLElement;
  /** The identity block holding the agent name control. */
  identity: () => HTMLElement | null;
  touch: boolean;
  reducedMotion: boolean;
  disabled: () => boolean;
  name: (index: number) => string;
  labels: (index: number, current: boolean) => string;
  pick: (index: number) => void;
};

export type AgentArcMotion = {
  setFaces: (elements: readonly HTMLElement[], current: number) => void;
  setCurrent: (current: number) => void;
  relabel: () => void;
  dispose: () => void;
};

export function createAgentArcMotion(options: AgentArcMotionOptions): AgentArcMotion {
  const { root, tip, touch } = options;
  const view = root.ownerDocument.defaultView!;
  const doc = root.ownerDocument;
  const reduced = options.reducedMotion;
  let faces: Face[] = [];
  let count = 0;
  let cur = 0;
  let unit = 1;
  let open = false;
  let menuOpen = false;
  let menuLit: number | null = null;
  let litI: number | null = null;
  let settling = 0;
  let closeT = 0;
  let openT = 0;
  let raf = 0;
  let last = 0;
  let timers: number[] = [];
  let needMove = false;
  let moveFrom: { x: number; y: number } | null = null;
  let disarm: { x: number; y: number; t: number } | null = null;
  let menuOpenAtPress = false;
  const ptr = { x: 9999, y: 9999, vx: 0, vy: 0, speed: 0, t: 0, on: false };
  const half = () => (touch ? TOUCH_AVATAR : HOVER_AVATAR) / 2;

  const offOf = (i: number, c = cur) => {
    let o = (((i - c) % count) + count) % count;
    if (o > count / 2) {
      o -= count;
    }
    return o;
  };
  const pose = (off: number, isOpen: boolean): Pose => {
    const sg = Math.sign(off);
    const ab = Math.abs(off);
    if (ab === 0) {
      return { x: 0, y: 0, s: 1, o: 1 };
    }
    if (touch) {
      return ab === 1
        ? { x: sg * 58 * unit, y: 5 * unit, s: NEIGHBOUR_SCALE, o: 0.58 }
        : { x: sg * (58 + (ab - 1) * 30) * unit, y: (5 + (ab - 1) * 9) * unit, s: 0.4, o: 0 };
    }
    if (!isOpen) {
      return { x: sg * 12 * unit, y: 2 * unit, s: 0.46, o: 0 };
    }
    if (ab > 2) {
      // Further seats keep the arc's spacing, so faces leaving never pile up.
      return {
        x: sg * (156 + (ab - 2) * 50) * unit,
        y: (24 + (ab - 2) * 22) * unit,
        s: 0.28,
        o: 0,
      };
    }
    const [x, y, s, o] = SEATS[ab as 1 | 2];
    return { x: sg * x * unit, y: y * unit, s, o };
  };
  const trigger = () =>
    options
      .identity()
      ?.querySelector<HTMLElement>(".agent-chat__welcome-name .agent-select__trigger") ?? null;
  const menu = () => {
    const list = trigger()?.getAttribute("aria-controls");
    return list ? doc.getElementById(`${list}-content`) : null;
  };
  const later = (run: () => void, ms: number) => {
    timers.push(view.setTimeout(run, ms));
  };
  function retarget(n: Face, base: Pose, mode: Mode, delay = 0) {
    n.next = base;
    n.nextMode = mode;
    n.at = performance.now() + delay;
  }
  function teleport(n: Face, p: Pose) {
    n.p = { ...p };
    n.v = zero();
    n.base = { ...p };
    n.next = null;
  }
  function wake() {
    if (!raf) {
      last = performance.now();
      raf = view.requestAnimationFrame(frame);
    }
  }

  function frame(now: number) {
    raf = 0;
    const dt = Math.min(0.032, (now - last) / 1000 || 0.016);
    last = now;
    const live = !touch && open && ptr.on && now > settling;
    // Who the pointer is reaching for: weights fall off with distance, so the aim reads before the cursor arrives.
    let best: number | null = null;
    let bestD = 1e9;
    const weights = faces.map((n) => {
      if (touch || n.off === 0 || Math.abs(n.off) > 2 || !open) {
        return 0;
      }
      if (menuLit === n.i) {
        return 1;
      }
      if (!live || needMove || n.next || n.p.o < 0.15) {
        return 0;
      }
      // Aim a little ahead of the cursor, along its direction of travel.
      const ax = ptr.x + ptr.vx * 55;
      const ay = ptr.y + ptr.vy * 55;
      const d = Math.hypot(ax - n.base.x, ay - n.base.y);
      const r = 48 * unit * n.base.s;
      if (
        Math.hypot(ptr.x, ptr.y) > 50 * unit &&
        Math.hypot(ptr.x - n.base.x, ptr.y - n.base.y) < r * 1.45 &&
        d < bestD
      ) {
        bestD = d;
        best = n.i;
      }
      return Math.exp(-((d / (74 * unit)) ** 2));
    });
    if (menuLit !== null) {
      best = menuLit;
    }
    if (best !== litI) {
      setLit(best);
    }
    let moving = now < settling || timers.length > 0;
    faces.forEach((n, index) => {
      if (n.next && now >= n.at) {
        n.base = n.next;
        n.mode = n.nextMode;
        n.next = null;
      }
      if (n.next) {
        moving = true;
      }
      const target = { ...n.base };
      const w = weights[index]!;
      let sat = n.off === 0 ? 1 : 0.72;
      if (!touch && n.off !== 0 && open && Math.abs(n.off) <= 2 && !n.next) {
        // Only the face being reached answers: it comes forward and takes its colour back.
        target.s *= 1 + 0.12 * w;
        target.o = Math.min(1, target.o + (1 - target.o) * Math.min(1, w * 1.3));
        target.y -= 2.5 * unit * w;
        sat += 0.28 * Math.min(1, w * 1.3);
      }
      const spring = touch
        ? SPRINGS.turn
        : live && !n.next && n.mode !== "turn"
          ? SPRINGS.live
          : SPRINGS[n.mode];
      for (const key of KEYS) {
        if (reduced) {
          n.p[key] = target[key];
          n.v[key] = 0;
          continue;
        }
        // Light never bounces; in a turn the face leaving the centre shrinks first and the one
        // arriving grows last, so they never fight for the same space.
        const shrink = key === "s" && (touch || n.mode === "turn") && target.s < n.p.s;
        // On the way out the light goes first, well before the slide ends.
        const out = !touch && key === "o" && n.mode === "exit";
        const k = out ? 600 : key === "o" ? Math.max(spring.k, 300) : shrink ? 330 : spring.k;
        const c = out ? 49 : key === "o" ? Math.max(spring.c, 36) : shrink ? 37 : spring.c;
        n.v[key] += (k * (target[key] - n.p[key]) - c * n.v[key]) * dt;
        n.p[key] += n.v[key] * dt;
        const scale = key === "x" || key === "y" ? 0.05 : 0.0005;
        if (Math.abs(target[key] - n.p[key]) > scale || Math.abs(n.v[key]) > scale * 10) {
          moving = true;
        }
      }
      if (touch) {
        sat =
          0.72 + 0.28 * Math.max(0, Math.min(1, (n.p.s - NEIGHBOUR_SCALE) / (1 - NEIGHBOUR_SCALE)));
      }
      const o = Math.max(0, Math.min(1, n.p.o));
      n.el.style.transform = `translate3d(${n.p.x.toFixed(2)}px, ${n.p.y.toFixed(2)}px, 0) scale(${Math.max(0.01, n.p.s).toFixed(4)})`;
      n.el.style.opacity = o.toFixed(3);
      n.el.style.filter = sat >= 0.995 ? "" : `saturate(${sat.toFixed(2)})`;
      n.el.style.visibility = o < 0.01 && n.off !== 0 ? "hidden" : "";
    });
    if (litI !== null) {
      const n = faces[litI]!;
      const h = half() * unit;
      tip.style.setProperty("--agent-arc-tip-x", `${n.p.x.toFixed(1)}px`);
      tip.style.setProperty("--agent-arc-tip-y", `${(h + n.p.y - h * n.p.s).toFixed(1)}px`);
    }
    if (!touch) {
      const centre = Math.hypot(ptr.x, ptr.y) < 50 * unit;
      root.style.cursor =
        (open && (litI !== null || centre)) || (!open && centre && count > 1) ? "pointer" : "";
    }
    if (moving) {
      raf = view.requestAnimationFrame(frame);
    } else {
      // Settled: land exactly on the targets until something moves again.
      faces.forEach((n) => (n.v = zero()));
    }
  }

  function setLit(i: number | null) {
    litI = i;
    tip.classList.toggle("is-on", i !== null && !menuOpen);
    if (i !== null) {
      tip.textContent = options.name(i);
    }
  }
  function sync() {
    faces.forEach((n) => {
      n.off = offOf(n.i);
      n.el.dataset.off = String(n.off);
      n.el.style.zIndex = String(n.off === 0 ? 6 : 4 - Math.min(3, Math.abs(n.off)));
      n.el.tabIndex =
        n.off === 0
          ? 0
          : touch
            ? Math.abs(n.off) <= 1
              ? 0
              : -1
            : open && Math.abs(n.off) <= 2
              ? 0
              : -1;
      n.el.setAttribute("aria-label", options.labels(n.i, n.off === 0));
    });
    root.dataset.open = String(open);
  }
  /** The fold opens as a wave from the side the pointer came from; it closes from the outside in. */
  function setOpen(value: boolean, entry = 0) {
    if (touch || open === value || (value && options.disabled())) {
      return;
    }
    open = value;
    sync();
    if (value) {
      settling = performance.now() + 240;
    }
    faces.forEach((n) => {
      if (n.off === 0) {
        return;
      }
      const sg = Math.sign(n.off);
      const ab = Math.abs(n.off);
      if (value) {
        retarget(n, pose(n.off, true), "open", (ab - 1) * 45 + (entry && sg !== entry ? 35 : 0));
      } else {
        retarget(n, pose(n.off, false), "close", (2 - Math.min(2, ab)) * 28);
      }
    });
    if (!value) {
      menuLit = null;
      setLit(null);
    }
    wake();
  }

  /** The name under the avatar swaps in place with the turn. */
  function turnName() {
    const name = options.identity()?.querySelector<HTMLElement>(".agent-chat__welcome-name");
    if (!name) {
      return;
    }
    name.removeAttribute("data-agent-arc-turn");
    void name.offsetWidth;
    name.setAttribute("data-agent-arc-turn", "");
  }

  /**
   * Choosing with a pointer is one gesture: the picked face travels to the centre and everyone
   * else rides the same turn out of view. Nobody folds back behind the centre.
   */
  function selectHover(i: number) {
    const k = offOf(i);
    const dir = Math.sign(k);
    const shift = dir * Math.min(2, Math.abs(k));
    const prev = faces.map((n) => n.off);
    cur = i;
    open = false;
    menuLit = null;
    setLit(null);
    settling = performance.now() + 700;
    needMove = true;
    moveFrom = { x: ptr.x, y: ptr.y };
    view.clearTimeout(closeT);
    closeT = 0;
    sync();
    faces.forEach((n, index) => {
      const was = prev[index]!;
      if (n.i === i) {
        if (Math.abs(was) > 2) {
          teleport(n, pose(dir * 3, true));
        }
        n.el.style.zIndex = "6";
        retarget(n, pose(0, true), "turn", 0);
        return;
      }
      if (Math.abs(was) > 2) {
        teleport(n, pose(n.off, false));
        return;
      }
      n.el.style.zIndex = String(was === 0 ? 5 : 3 - Math.abs(was));
      // Each face moves k seats along the arc, in the direction of the turn.
      const to = pose(was - shift || -dir, true);
      retarget(n, { x: to.x, y: to.y, s: to.s * 0.92, o: 0 }, "exit", Math.abs(was - k) * 28);
    });
    // Once they are out of sight, park them folded behind the new agent, ready for the next hover.
    later(() => {
      faces.forEach((n) => {
        if (n.off !== 0) {
          teleport(n, pose(n.off, false));
        }
        n.mode = "open";
      });
      timers = [];
      wake();
    }, 620);
    // Hover stays off until the pointer leaves the area, or after a beat travels well away.
    disarm = { x: ptr.x, y: ptr.y, t: performance.now() };
    wake();
  }

  /**
   * On touch the row turns like a carousel: the picked face comes to the centre, the old one takes
   * the seat beside it, whoever falls off one end leaves and the next in line comes in at the other.
   */
  function selectTouch(i: number) {
    const k = offOf(i);
    const dir = Math.sign(k);
    const prev = faces.map((n) => n.off);
    cur = i;
    sync();
    if (Math.abs(k) > 1) {
      // Not a neighbour: nobody travels. The three faces go out where they stand and the new three
      // come up in their seats, centre first.
      faces.forEach((n, index) => {
        const was = prev[index]!;
        const now = n.off;
        const wasVisible = Math.abs(was) <= 1;
        const nowVisible = Math.abs(now) <= 1;
        if (wasVisible) {
          const p = pose(was, true);
          retarget(n, { ...p, s: p.s * 0.86, o: 0 }, "turn");
        } else {
          const p = pose(now, true);
          teleport(n, { ...p, s: p.s * 0.86, o: 0 });
        }
        if (nowVisible) {
          later(() => {
            const p = pose(now, true);
            teleport(n, { ...p, s: p.s * 0.86, o: 0 });
            retarget(n, p, "turn", now === 0 ? 0 : 60);
            wake();
          }, 170);
        } else if (wasVisible) {
          later(() => teleport(n, pose(now, true)), 400);
        }
      });
      later(() => (timers = []), 420);
      wake();
      return;
    }
    faces.forEach((n, index) => {
      const was = prev[index]!;
      const now = n.off;
      const wasVisible = Math.abs(was) <= 1;
      const nowVisible = Math.abs(now) <= 1;
      if (n.i === i) {
        if (!wasVisible) {
          teleport(n, pose(dir * 2, true));
        }
        n.el.style.zIndex = "6";
        retarget(n, pose(0, true), "turn");
        return;
      }
      if (wasVisible && nowVisible) {
        if (was !== 0 && Math.sign(was) !== Math.sign(now)) {
          // Few agents: the same face leaves one end and comes back at the other.
          retarget(n, pose(-dir * 2, true), "turn");
          later(() => {
            teleport(n, pose(dir * 2, true));
            retarget(n, pose(now, true), "turn");
            wake();
          }, 210);
          return;
        }
        retarget(n, pose(now, true), "turn");
        return;
      }
      if (wasVisible) {
        retarget(n, pose(-dir * 2, true), "turn");
        return;
      }
      if (nowVisible) {
        if (Math.sign(now) === dir) {
          teleport(n, pose(dir * 2, true));
          retarget(n, pose(now, true), "turn", 40);
          return;
        }
        const p = pose(now, true);
        teleport(n, { ...p, s: p.s * 0.7, o: 0 });
        retarget(n, p, "turn", 150);
        return;
      }
      teleport(n, pose(now, true));
    });
    later(() => (timers = []), 260);
    wake();
  }

  function rest() {
    faces.forEach((n) => teleport(n, pose(offOf(n.i), open)));
    wake();
  }

  /* ---------- pointer intent ---------- */
  const inZone = () => Math.abs(ptr.x) < 214 * unit && ptr.y > -72 * unit && ptr.y < 68 * unit;
  const overTrigger = (target: EventTarget | null) =>
    target instanceof Node && Boolean(trigger()?.contains(target));
  const overMenu = (target: EventTarget | null) =>
    target instanceof Node && Boolean(menu()?.contains(target));
  function onMove(event: PointerEvent) {
    if (!count || options.disabled()) {
      return;
    }
    const r = root.getBoundingClientRect();
    const x = event.clientX - r.left - r.width / 2;
    const y = event.clientY - r.top - r.height / 2;
    const dt = Math.max(1, event.timeStamp - ptr.t);
    ptr.vx = ptr.vx * 0.6 + ((x - ptr.x) / dt) * 0.4;
    ptr.vy = ptr.vy * 0.6 + ((y - ptr.y) / dt) * 0.4;
    if (!ptr.on) {
      ptr.vx = ptr.vy = 0;
    }
    ptr.speed = Math.hypot(ptr.vx, ptr.vy);
    ptr.x = x;
    ptr.y = y;
    ptr.t = event.timeStamp;
    ptr.on = true;
    if (open || Math.hypot(x, y) < 120 * unit) {
      wake();
    }
    // After a turn, the face that landed under the cursor waits for a real move.
    if (needMove && moveFrom && Math.hypot(x - moveFrom.x, y - moveFrom.y) > 6) {
      needMove = false;
    }
    if (disarm) {
      const far = Math.hypot(x - disarm.x, y - disarm.y) > 48 && performance.now() - disarm.t > 900;
      if (!inZone() || far) {
        disarm = null;
      } else {
        return;
      }
    }
    const centre = Math.hypot(x, y) < 50 * unit;
    const onTrigger = overTrigger(event.target);
    if (!open) {
      if (!centre && !onTrigger) {
        view.clearTimeout(openT);
        openT = 0;
        return;
      }
      // Intent: a slow approach opens at once; a pointer just passing through has to linger.
      const go = () => {
        openT = 0;
        if (Math.hypot(ptr.x, ptr.y) < 50 * unit || onTrigger) {
          setOpen(true, Math.sign(-ptr.vx) || 0);
        }
      };
      if (ptr.speed < 0.55) {
        go();
      } else if (!openT) {
        openT = view.setTimeout(go, 80);
      }
      return;
    }
    if (inZone() || onTrigger || overMenu(event.target)) {
      view.clearTimeout(closeT);
      closeT = 0;
      return;
    }
    if (menuOpen || closeT) {
      return;
    }
    // Leaving toward the page closes quickly; drifting just outside the arc gets a moment of grace.
    const away = ptr.speed > 0.25 && ptr.vx * -x + ptr.vy * -y < 0;
    closeT = view.setTimeout(
      () => {
        closeT = 0;
        if (!menuOpen && !inZone()) {
          setOpen(false);
        }
      },
      away ? 90 : 260,
    );
  }
  function onLeave() {
    ptr.on = false;
  }
  function onFocusIn(event: FocusEvent) {
    if (event.target instanceof Element && event.target.matches(":focus-visible")) {
      setOpen(true);
    }
  }
  function onPress(event: PointerEvent) {
    menuOpenAtPress = menuOpen;
    if (
      menuOpen &&
      event.target instanceof Node &&
      !root.contains(event.target) &&
      !overTrigger(event.target) &&
      !overMenu(event.target)
    ) {
      setOpen(false);
    }
  }
  function onClick(event: MouseEvent) {
    if (options.disabled()) {
      return;
    }
    const keyboard = event.detail === 0;
    const button =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>(".agent-arc__face")
        : null;
    const index = button ? faces.findIndex((n) => n.el === button) : -1;
    const i =
      touch || keyboard
        ? index >= 0
          ? index
          : null
        : Math.hypot(ptr.x, ptr.y) < 50 * unit
          ? cur
          : litI;
    if (i === null) {
      return;
    }
    if (i === cur) {
      // The avatar opens the Agents menu, like the name. A press that already dismissed it stays closed.
      if (!(menuOpenAtPress && !menuOpen && !keyboard)) {
        trigger()?.click();
      }
      menuOpenAtPress = false;
      return;
    }
    menuOpenAtPress = false;
    options.pick(i);
  }
  /* ---------- the Agents menu, opened from the name or the avatar ---------- */
  function readMenuOpen() {
    const next = trigger()?.getAttribute("aria-expanded") === "true";
    if (next === menuOpen) {
      return;
    }
    menuOpen = next;
    if (next) {
      setOpen(true);
    } else {
      menuLit = null;
    }
    setLit(litI);
    wake();
  }
  function onMenuOver(event: PointerEvent) {
    if (!menuOpen || !overMenu(event.target) || !(event.target instanceof Element)) {
      return;
    }
    const value = event.target.closest<HTMLElement>(".agent-select__option")?.dataset.value;
    const index = value ? faces.findIndex((n) => n.el.dataset.agentId === value) : -1;
    menuLit = index >= 0 && index !== cur ? index : null;
    wake();
  }
  function onMenuOut(event: PointerEvent) {
    if (menuLit !== null && !overMenu(event.relatedTarget)) {
      menuLit = null;
      wake();
    }
  }

  const stops: (() => void)[] = [];
  const listen = <K extends keyof HTMLElementEventMap>(
    target: EventTarget,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
    capture = false,
  ) => {
    const listener = handler as EventListener;
    target.addEventListener(type, listener, capture);
    stops.push(() => target.removeEventListener(type, listener, capture));
  };
  listen(root, "click", onClick);
  if (!touch) {
    listen(doc, "pointermove", onMove);
    listen(doc.documentElement, "pointerleave", onLeave);
    listen(view, "pointerdown", onPress, true);
    listen(root, "focusin", onFocusIn);
    listen(doc, "pointerover", onMenuOver);
    listen(doc, "pointerout", onMenuOut);
    const observer = new MutationObserver(readMenuOpen);
    const identity = options.identity();
    if (identity) {
      observer.observe(identity, {
        attributes: true,
        attributeFilter: ["aria-expanded"],
        subtree: true,
      });
    }
    stops.push(() => observer.disconnect());
  }
  const resize = new ResizeObserver(() => {
    const next = root.offsetWidth / (touch ? TOUCH_AVATAR : HOVER_AVATAR) || 1;
    if (Math.abs(next - unit) > 0.001) {
      unit = next;
      rest();
    }
  });
  resize.observe(root);
  stops.push(() => resize.disconnect());
  unit = root.offsetWidth / (touch ? TOUCH_AVATAR : HOVER_AVATAR) || 1;

  return {
    setFaces(elements, current) {
      count = elements.length;
      cur = Math.max(0, current);
      faces = elements.map((el, i) => {
        const p = pose(offOf(i), open);
        return {
          el,
          i,
          off: 0,
          p: { ...p },
          v: zero(),
          base: { ...p },
          mode: "open",
          next: null,
          nextMode: "open",
          at: 0,
        };
      });
      sync();
      rest();
    },
    setCurrent(current) {
      if (current < 0 || current === cur || !count) {
        return;
      }
      turnName();
      if (touch) {
        selectTouch(current);
      } else {
        selectHover(current);
      }
    },
    relabel() {
      faces.forEach((n) => n.el.setAttribute("aria-label", options.labels(n.i, n.off === 0)));
      if (litI !== null) {
        tip.textContent = options.name(litI);
      }
    },
    dispose() {
      stops.forEach((stop) => stop());
      timers.forEach((timer) => view.clearTimeout(timer));
      view.clearTimeout(closeT);
      view.clearTimeout(openT);
      if (raf) {
        view.cancelAnimationFrame(raf);
      }
    },
  };
}
