import { createEffect, createMemo, createSignal, isPending, onSettled } from "solid-js";
import { currentThemeBranding, subscribeThemeBranding } from "../app/theme-branding.ts";
import { observeDocumentRootAttributes } from "../lib/reactive/document-root-attributes.ts";
import { createIntersectionObserver } from "../lib/reactive/observers.ts";
import { createDocumentVisibility, createMediaQuery } from "../lib/reactive/platform.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import { defineSolidBridge } from "../lib/solid-bridge.ts";
import type { MascotAnimator } from "./mascot-animator.ts";
import { drawMascot } from "./mascot-canvas.ts";
import {
  MASCOT_MOODS,
  mascotPalette,
  staticMascotPose,
  type MascotMood,
  type MascotPose,
} from "./mascot-pose.ts";
import { ThemeBrandIcon } from "./theme-brand-icon.tsx";
import "./openclaw-mascot.css";

type Props = { mood: MascotMood; size: number; tease: boolean };
const moods = new Set<MascotMood>(MASCOT_MOODS);

defineSolidBridge<Props>(
  "openclaw-mascot",
  (props, host) => {
    host.setAttribute("aria-hidden", "true");
    const branding = projectSource(undefined, {
      read: currentThemeBranding,
      subscribe: (_, notify) => subscribeThemeBranding(notify),
      equality: Object.is,
    });
    const [animationRequested, setAnimationRequested] = createSignal(false);
    const animation = createMemo(async () => {
      if (!animationRequested()) {
        return undefined;
      }
      try {
        const { MascotAnimator } = await import("./mascot-animator.ts");
        return new MascotAnimator();
      } catch {
        // Optional motion can fail independently; the same canvas keeps its static pose.
        return undefined;
      }
    });
    let animator: MascotAnimator | undefined;
    const [themeRevision, setThemeRevision] = createSignal(0);
    const mood = () => (moods.has(props.mood) ? props.mood : "idle");
    const size = () => (Number.isFinite(props.size) && props.size > 0 ? props.size : 120);
    const reducedMotion = createMediaQuery("(prefers-reduced-motion: reduce)");
    const documentVisible = createDocumentVisibility();
    let animationFrame = 0;
    let visible = typeof IntersectionObserver === "undefined";
    let canvas: HTMLCanvasElement | undefined;
    // Native frame/observer callbacks consume the last committed canvas inputs.
    let drawingSize = 120;
    let stillPose: MascotPose | undefined;
    let playbackEnabled = false;
    const shouldAnimate = () => canvas?.isConnected && visible && playbackEnabled && animator;
    const stopAnimation = () => {
      if (animationFrame) {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = 0;
      }
    };
    const drawPose = (pose: MascotPose) => {
      const element = canvas;
      const context = typeof Path2D === "undefined" ? null : element?.getContext("2d");
      if (!element?.isConnected || !context) {
        return;
      }
      const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
      const pixelSize = Math.round(drawingSize * pixelRatio);
      if (element.width !== pixelSize || element.height !== pixelSize) {
        element.width = pixelSize;
        element.height = pixelSize;
      }
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, drawingSize, drawingSize);
      drawMascot(
        pose,
        mascotPalette(document.documentElement.dataset.themeMode === "light"),
        context,
        drawingSize,
      );
      element.style.transform = `translate3d(0, ${(pose.floatOffset * drawingSize) / 120}px, 0)`;
    };
    const draw = (time: number) => {
      const pose = stillPose ?? animator?.poseAt(time);
      if (pose) {
        drawPose(pose);
      }
    };
    const renderFrame = (timestamp: number) => {
      animationFrame = 0;
      if (!shouldAnimate()) {
        return;
      }
      draw(timestamp / 1_000);
      animationFrame = window.requestAnimationFrame(renderFrame);
    };
    const syncPlayback = () => {
      if (visible && playbackEnabled) {
        setAnimationRequested(true);
      }
      if (!shouldAnimate()) {
        stopAnimation();
        if (stillPose) {
          drawPose(stillPose);
        }
      } else if (!animationFrame) {
        animationFrame = window.requestAnimationFrame(renderFrame);
      }
    };
    const configuration = createMemo(
      () => [mood(), props.tease, size(), branding.read(), themeRevision()] as const,
    );
    createEffect(
      () =>
        [
          configuration(),
          reducedMotion(),
          documentVisible(),
          isPending(animation) ? undefined : animation(),
        ] as const,
      ([current, motionReduced, documentIsVisible, loadedAnimator], previous) => {
        const [currentMood, tease, currentSize, currentBranding] = current;
        drawingSize = currentSize;
        animator = loadedAnimator;
        stillPose = motionReduced || !animator ? staticMascotPose(currentMood) : undefined;
        playbackEnabled =
          currentBranding.brandIcon === "claw" && !motionReduced && documentIsVisible;
        // Visibility changes resume playback without resetting the tease timestamp.
        if (current !== previous?.[0] || animator !== previous?.[3]) {
          const time = performance.now() / 1_000;
          animator?.setMood(currentMood, time);
          animator?.setTease(tease, time);
          host.style.setProperty("--openclaw-mascot-size", `${currentSize}px`);
          draw(time);
        }
        syncPlayback();
      },
    );
    createIntersectionObserver(
      () => [host],
      (entries) => {
        visible = entries.some((entry) => entry.isIntersecting);
        syncPlayback();
      },
    );
    onSettled(() => {
      const stopTheme = observeDocumentRootAttributes(
        document,
        ["data-theme-mode", "data-theme-mascot"],
        () => setThemeRevision((value) => value + 1),
      );
      draw(performance.now() / 1_000);
      syncPlayback();
      return () => {
        stopTheme();
        stopAnimation();
      };
    });
    return (
      <>
        {branding.read().brandIcon === "claw" ? (
          <canvas ref={(element) => (canvas = element)} />
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
