// Pure pose model shared by the mascot animator and canvas renderer.

export type MascotMood =
  | "idle"
  | "curious"
  | "thinking"
  | "working"
  | "happy"
  | "celebrating"
  | "sad"
  | "sleepy"
  | "attentive";

type MascotEffect = "none" | "sparkles" | "zzz" | "sparks" | "sweat";

export type MascotPose = {
  floatOffset: number;
  antennaDegrees: number;
  antennaDroop: number;
  leftClawDegrees: number;
  rightClawDegrees: number;
  eyeGlowOpacity: number;
  glowScale: number;
  leftEyeOpenness: number;
  rightEyeOpenness: number;
  happyEyes: number;
  gaze: { x: number; y: number };
  mouthCurve: number;
  mouthOpen: number;
  mouthRound: number;
  blush: number;
  hardHat: number;
  bodyTilt: number;
  bodyStretch: number;
  effect: MascotEffect;
  effectPhase: number;
};

export type MascotPalette = {
  gradientTop: string;
  gradientBottom: string;
  antenna: string;
};

const DARK_PALETTE: MascotPalette = {
  gradientTop: "#ff4d4d",
  gradientBottom: "#991b1b",
  antenna: "#ff4d4d",
};

const LIGHT_PALETTE: MascotPalette = {
  gradientTop: "#ff7079",
  gradientBottom: "#ea4c59",
  antenna: "#ef4b58",
};

export function createMascotPose(): MascotPose {
  return {
    floatOffset: 0,
    antennaDegrees: 0,
    antennaDroop: 0,
    leftClawDegrees: 0,
    rightClawDegrees: 0,
    eyeGlowOpacity: 1,
    glowScale: 1,
    leftEyeOpenness: 1,
    rightEyeOpenness: 1,
    happyEyes: 0,
    gaze: { x: 0, y: 0 },
    mouthCurve: 0,
    mouthOpen: 0,
    mouthRound: 0,
    blush: 0,
    hardHat: 0,
    bodyTilt: 0,
    bodyStretch: 1,
    effect: "none",
    effectPhase: 0,
  };
}

export function clampMascotValue(value: number, min = 0, max = 1): number {
  return Math.min(Math.max(value, min), max);
}

export function mascotEaseInOut(value: number): number {
  const t = clampMascotValue(value);
  return t * t * (3 - 2 * t);
}

export function mascotBell(value: number): number {
  const t = clampMascotValue(value);
  return mascotEaseInOut(t < 0.5 ? t * 2 : (1 - t) * 2);
}

/** Keep every channel inside the drawable 120x120 art-space bounds. */
export function clampMascotPose(pose: MascotPose): MascotPose {
  pose.floatOffset = clampMascotValue(pose.floatOffset, -12, 2);
  pose.antennaDegrees = clampMascotValue(pose.antennaDegrees, -14, 14);
  pose.antennaDroop = clampMascotValue(pose.antennaDroop, 0, 1);
  pose.leftClawDegrees = clampMascotValue(pose.leftClawDegrees, -45, 45);
  pose.rightClawDegrees = clampMascotValue(pose.rightClawDegrees, -45, 45);
  pose.eyeGlowOpacity = clampMascotValue(pose.eyeGlowOpacity, 0, 1);
  pose.glowScale = clampMascotValue(pose.glowScale, 0.5, 1.6);
  pose.leftEyeOpenness = clampMascotValue(pose.leftEyeOpenness, 0, 1);
  pose.rightEyeOpenness = clampMascotValue(pose.rightEyeOpenness, 0, 1);
  pose.happyEyes = clampMascotValue(pose.happyEyes, 0, 1);
  pose.gaze.x = clampMascotValue(pose.gaze.x, -1.2, 1.2);
  pose.gaze.y = clampMascotValue(pose.gaze.y, -1.2, 1.2);
  pose.mouthCurve = clampMascotValue(pose.mouthCurve, -1, 1);
  pose.mouthOpen = clampMascotValue(pose.mouthOpen, 0, 1);
  pose.mouthRound = clampMascotValue(pose.mouthRound, 0, 1);
  pose.blush = clampMascotValue(pose.blush, 0, 1);
  pose.hardHat = clampMascotValue(pose.hardHat, 0, 1);
  pose.bodyTilt = clampMascotValue(pose.bodyTilt, -8, 8);
  pose.bodyStretch = clampMascotValue(pose.bodyStretch, 0.86, 1.05);
  return pose;
}

/** Motionless mood expression used when reduced motion is requested. */
export function staticMascotPose(mood: MascotMood): MascotPose {
  const pose = createMascotPose();
  switch (mood) {
    case "idle":
    case "curious":
    case "attentive":
      break;
    case "thinking":
      pose.gaze = { x: 0.3, y: -0.5 };
      break;
    case "working":
      pose.hardHat = 1;
      pose.rightClawDegrees = -28;
      pose.gaze = { x: 0.4, y: 0.35 };
      pose.mouthCurve = 0.15;
      pose.bodyTilt = 2;
      break;
    case "happy":
      pose.mouthCurve = 0.6;
      pose.happyEyes = 0.4;
      break;
    case "celebrating":
      pose.mouthCurve = 0.9;
      pose.mouthOpen = 0.4;
      pose.happyEyes = 0.8;
      pose.leftClawDegrees = 30;
      pose.rightClawDegrees = -30;
      break;
    case "sad":
      pose.antennaDroop = 0.75;
      pose.mouthCurve = -0.55;
      pose.eyeGlowOpacity = 0.6;
      pose.gaze = { x: 0, y: 0.5 };
      break;
    case "sleepy":
      pose.leftEyeOpenness = 0.25;
      pose.rightEyeOpenness = 0.25;
      pose.eyeGlowOpacity = 0.5;
      pose.antennaDroop = 0.35;
      break;
  }
  return pose;
}

export function mascotPalette(light: boolean): MascotPalette {
  return light ? LIGHT_PALETTE : DARK_PALETTE;
}
