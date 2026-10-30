/**
 * Spring motion shared by mobile sheets, drawers and panels.
 *
 * Parameters follow Apple's duration/bounce model (SwiftUI `Spring(duration:bounce:)`,
 * WWDC23 "Animate with springs"): unit mass, stiffness `(2π / duration)²`, and damping
 * `4π(1 − bounce) / duration` for bounce ≥ 0 or `4π / (duration · (1 + bounce))` below 0.
 * CSS consumes the curve as a `linear()` easing sampled from the closed-form solution,
 * so a gesture release carries its velocity into an ordinary CSS transition.
 */
export type Spring = {
  /** Perceptual duration in seconds; the curve settles shortly after it. */
  readonly duration: number;
  /** 0 is critically damped, positive values overshoot, negative values overdamp. */
  readonly bounce: number;
};

/**
 * Critically damped like SwiftUI's default `.smooth`, with the pace fitted to the iOS sheet
 * presentation curve that Ionic and Vaul reproduce (`cubic-bezier(0.32, 0.72, 0, 1)` over
 * 500 ms): 0.3 s matches it within ~1.5% RMS, then settles naturally and accepts velocity.
 */
export const SHEET_SPRING: Spring = { duration: 0.3, bounce: 0 };

/** Residual displacement (fraction of the distance) treated as settled. */
const SETTLE_EPSILON = 0.001;
const MAX_SETTLE_SECONDS = 2;
/** Largest gap between the spring and its `linear()` approximation, as a fraction of the
    distance: under 1.5 px on a phone-height sheet, with about a dozen stops. */
const EASING_TOLERANCE = 0.003;

export function springCoefficients(spring: Spring): { stiffness: number; damping: number } {
  const stiffness = ((2 * Math.PI) / spring.duration) ** 2;
  const damping =
    spring.bounce >= 0
      ? (4 * Math.PI * (1 - spring.bounce)) / spring.duration
      : (4 * Math.PI) / (spring.duration * (1 + spring.bounce));
  return { stiffness, damping };
}

/**
 * Normalized position (0 → 1) after `time` seconds. `velocity` is the initial speed in
 * distances per second: the "relative velocity" from WWDC18 "Designing Fluid Interfaces".
 */
export function springValue(spring: Spring, time: number, velocity = 0): number {
  const { stiffness, damping } = springCoefficients(spring);
  const omega = Math.sqrt(stiffness);
  const zeta = damping / (2 * omega);
  // Displacement y = position − 1 starts at −1 with y'(0) = velocity.
  if (Math.abs(zeta - 1) < 1e-9) {
    return 1 + (-1 + (velocity - omega) * time) * Math.exp(-omega * time);
  }
  if (zeta < 1) {
    const damped = omega * Math.sqrt(1 - zeta * zeta);
    const sine = (velocity - zeta * omega) / damped;
    return (
      1 +
      Math.exp(-zeta * omega * time) * (-Math.cos(damped * time) + sine * Math.sin(damped * time))
    );
  }
  const root = omega * Math.sqrt(zeta * zeta - 1);
  const slow = -zeta * omega + root;
  const fast = -zeta * omega - root;
  const fastWeight = (velocity + slow) / (fast - slow);
  return 1 + (-1 - fastWeight) * Math.exp(slow * time) + fastWeight * Math.exp(fast * time);
}

/** Seconds until the spring stays within the settle epsilon of its target. */
export function springSettleTime(spring: Spring, velocity = 0): number {
  let settled = 0;
  for (let ms = 0; ms <= MAX_SETTLE_SECONDS * 1000; ms += 1) {
    if (Math.abs(1 - springValue(spring, ms / 1000, velocity)) > SETTLE_EPSILON) {
      settled = (ms + 1) / 1000;
    }
  }
  return settled;
}

/**
 * A CSS `linear()` easing plus the transition duration that plays the spring to rest.
 * Distance enters only through the relative `velocity`; callers keep their transitions.
 * Stops are placed greedily: each segment extends while every millisecond sample stays
 * within the tolerance of the straight line that replaces it.
 */
export function springEasing(spring: Spring, velocity = 0): { easing: string; durationMs: number } {
  const durationMs = Math.max(1, Math.round(springSettleTime(spring, velocity) * 1000));
  const samples = Array.from({ length: durationMs + 1 }, (_, ms) =>
    ms === durationMs ? 1 : springValue(spring, ms / 1000, velocity),
  );
  const fits = (from: number, to: number) => {
    for (let ms = from + 1; ms < to; ms += 1) {
      const line = samples[from]! + ((samples[to]! - samples[from]!) * (ms - from)) / (to - from);
      if (Math.abs(line - samples[ms]!) > EASING_TOLERANCE) {
        return false;
      }
    }
    return true;
  };
  const stops = ["0"];
  for (let from = 0; from < durationMs;) {
    let to = from + 1;
    while (to < durationMs && fits(from, to + 1)) {
      to += 1;
    }
    stops.push(
      to === durationMs
        ? "1"
        : `${Math.round(samples[to]! * 1000) / 1000} ${Math.round((to / durationMs) * 1000) / 10}%`,
    );
    from = to;
  }
  return { easing: `linear(${stops.join(", ")})`, durationMs };
}
