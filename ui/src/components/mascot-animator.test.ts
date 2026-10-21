// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MascotAnimator } from "./mascot-animator.ts";
import { MASCOT_MOODS, staticMascotPose, type MascotPose } from "./mascot-pose.ts";

function expectPoseInBounds(pose: MascotPose): void {
  for (const [value, min, max] of [
    [pose.floatOffset, -12, 2],
    [pose.antennaDegrees, -14, 14],
    [pose.leftClawDegrees, -45, 45],
    [pose.rightClawDegrees, -45, 45],
    [pose.glowScale, 0.5, 1.6],
    [pose.gaze.x, -1.2, 1.2],
    [pose.gaze.y, -1.2, 1.2],
    [pose.mouthCurve, -1, 1],
    [pose.bodyTilt, -8, 8],
    [pose.bodyStretch, 0.86, 1.05],
    [pose.antennaDroop, 0, 1],
    [pose.eyeGlowOpacity, 0, 1],
    [pose.leftEyeOpenness, 0, 1],
    [pose.rightEyeOpenness, 0, 1],
    [pose.happyEyes, 0, 1],
    [pose.mouthOpen, 0, 1],
    [pose.mouthRound, 0, 1],
    [pose.hardHat, 0, 1],
  ] as const) {
    expect(value).toBeGreaterThanOrEqual(min);
    expect(value).toBeLessThanOrEqual(max);
  }
}

describe("MascotAnimator", () => {
  it("keeps every mood inside drawable channel bounds for 30 seconds", () => {
    for (const [index, mood] of MASCOT_MOODS.entries()) {
      const animator = new MascotAnimator(1_000 + index);
      animator.setMood(mood, 0);
      for (let frame = 0; frame <= 30 * 30; frame += 1) {
        expectPoseInBounds(animator.poseAt(frame / 30));
      }
    }
  });

  it("cancels stale gestures when the mood changes", () => {
    // Change mood before idle's queued hello wave at +0.9s.
    const animator = new MascotAnimator(9);
    animator.poseAt(0);
    animator.setMood("thinking", 0.1);

    for (let frame = 3; frame <= 4 * 30; frame += 1) {
      const pose = animator.poseAt(frame / 30);
      // A stale wave exceeds thinking's base loop and claw snap (-8°).
      expect(pose.rightClawDegrees).toBeGreaterThan(-15);
    }
  });

  it("overlays and clears the composer tease expression", () => {
    const animator = new MascotAnimator(17);
    animator.setMood("idle", 0);
    animator.setTease(true, 0);

    expect(animator.poseAt(0)).toMatchObject({ mouthRound: 0.5, gaze: { x: 0, y: 0.6 } });

    animator.setTease(false, 0.1);
    const cleared = animator.poseAt(0.1);
    expect(cleared.mouthRound).toBe(0);
    expect(cleared.gaze).not.toEqual({ x: 0, y: 0.6 });
  });
  it("preserves the identifying expression for each motionless mood", () => {
    expect(staticMascotPose("thinking").gaze.y).toBeLessThan(0);
    expect(staticMascotPose("working")).toMatchObject({ hardHat: 1, rightClawDegrees: -28 });
    expect(staticMascotPose("happy").mouthCurve).toBeGreaterThan(0.5);
    expect(staticMascotPose("celebrating").leftClawDegrees).toBeGreaterThan(25);
    expect(staticMascotPose("celebrating").rightClawDegrees).toBeLessThan(-25);
    expect(staticMascotPose("sad")).toMatchObject({ antennaDroop: 0.75, mouthCurve: -0.55 });
    expect(staticMascotPose("sleepy").leftEyeOpenness).toBe(0.25);
    expect(staticMascotPose("attentive")).toEqual(staticMascotPose("idle"));
  });
});
