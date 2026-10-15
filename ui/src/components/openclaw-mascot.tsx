import { createEffect, createSignal, onCleanup, onSettled } from "solid-js";
import { currentThemeBranding, subscribeThemeBranding } from "../app/theme-branding.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import { defineSolidBridge } from "../lit/solid-bridge.ts";
import { MascotAnimator } from "./mascot-animator.ts";
import { drawMascot } from "./mascot-canvas.ts";
import {
  mascotPalette,
  staticMascotPose,
  type MascotMood,
  type MascotPose,
} from "./mascot-pose.ts";
import { ThemeBrandIcon } from "./theme-brand-icon.tsx";
import "./openclaw-mascot.css";

type Props = { mood: MascotMood; size: number; tease: boolean };
const moods = new Set<MascotMood>([
  "idle",
  "curious",
  "thinking",
  "working",
  "happy",
  "celebrating",
  "sad",
  "sleepy",
  "attentive",
]);

defineSolidBridge<Props>(
  "openclaw-mascot",
  (props, host) => {
    host.setAttribute("aria-hidden", "true");
    const branding = projectSource(undefined, {
      read: currentThemeBranding,
      subscribe: (_, notify) => subscribeThemeBranding(notify),
      equality: Object.is,
    });
    const animator = new MascotAnimator();
    const [themeRevision, setThemeRevision] = createSignal(0);
    const mood = () => (moods.has(props.mood) ? props.mood : "idle");
    const size = () => (Number.isFinite(props.size) && props.size > 0 ? props.size : 120);
    let animationFrame = 0;
    let visible = true;
    let reducedMotion = false;
    const canvas = () => host.querySelector("canvas");
    const shouldAnimate = () =>
      host.isConnected &&
      branding.read().brandIcon === "claw" &&
      visible &&
      !reducedMotion &&
      document.visibilityState !== "hidden";
    const stopAnimation = () => {
      if (animationFrame) {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = 0;
      }
    };
    const drawPose = (pose: MascotPose) => {
      const element = canvas();
      if (!element || typeof Path2D === "undefined") {
        return;
      }
      const context = element.getContext("2d");
      if (!context) {
        return;
      }
      const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
      const pixelSize = Math.round(size() * pixelRatio);
      if (element.width !== pixelSize || element.height !== pixelSize) {
        element.width = pixelSize;
        element.height = pixelSize;
      }
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, size(), size());
      drawMascot(
        pose,
        mascotPalette(document.documentElement.dataset.themeMode === "light"),
        context,
        size(),
      );
      element.style.transform = `translate3d(0, ${(pose.floatOffset * size()) / 120}px, 0)`;
    };
    const draw = (time: number) =>
      drawPose(reducedMotion ? staticMascotPose(mood()) : animator.poseAt(time));
    const renderFrame = (timestamp: number) => {
      animationFrame = 0;
      if (!shouldAnimate()) {
        return;
      }
      draw(timestamp / 1_000);
      animationFrame = window.requestAnimationFrame(renderFrame);
    };
    const syncPlayback = () => {
      if (!canvas() || !shouldAnimate()) {
        stopAnimation();
        if (canvas() && reducedMotion) {
          drawPose(staticMascotPose(mood()));
        }
      } else if (!animationFrame) {
        animationFrame = window.requestAnimationFrame(renderFrame);
      }
    };
    createEffect(
      () => [props.mood, props.tease, props.size, branding.read(), themeRevision()] as const,
      () => {
        const time = performance.now() / 1_000;
        animator.setMood(mood(), time);
        animator.setTease(props.tease, time);
        host.style.setProperty("--openclaw-mascot-size", `${size()}px`);
        draw(time);
        syncPlayback();
      },
    );
    onSettled(() => {
      const motionQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)");
      reducedMotion = motionQuery?.matches ?? false;
      const motionChange = (event: MediaQueryListEvent) => {
        reducedMotion = event.matches;
        syncPlayback();
      };
      document.addEventListener("visibilitychange", syncPlayback);
      motionQuery?.addEventListener("change", motionChange);
      const intersection =
        typeof IntersectionObserver === "undefined"
          ? undefined
          : new IntersectionObserver((entries) => {
              visible = entries.some((entry) => entry.isIntersecting);
              syncPlayback();
            });
      intersection?.observe(host);
      const themeObserver = new MutationObserver(() => setThemeRevision((value) => value + 1));
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme-mode", "data-theme-mascot"],
      });
      draw(performance.now() / 1_000);
      syncPlayback();
      return () => {
        document.removeEventListener("visibilitychange", syncPlayback);
        motionQuery?.removeEventListener("change", motionChange);
        intersection?.disconnect();
        themeObserver.disconnect();
      };
    });
    onCleanup(stopAnimation);
    return (
      <>
        {branding.read().brandIcon === "claw" ? (
          <canvas />
        ) : (
          <span class="openclaw-mascot--neutral">
            <ThemeBrandIcon branding={branding.read()} />
          </span>
        )}
      </>
    );
  },
  {
    properties: {
      mood: { default: "idle", reflect: true },
      size: { default: 120, type: Number },
      tease: { default: false, type: Boolean },
    },
  },
);
