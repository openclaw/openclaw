import { createEffect, createSignal, onCleanup, onSettled } from "solid-js";
import { currentThemeBranding, subscribeThemeBranding } from "../app/theme-branding.ts";
import { createIntersectionObserver } from "../lib/reactive/observers.ts";
import { createDocumentVisibility, createMediaQuery } from "../lib/reactive/platform.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import { defineSolidBridge } from "../lib/solid-bridge.ts";
import { MascotAnimator } from "./mascot-animator.ts";
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
    const animator = new MascotAnimator();
    const [themeRevision, setThemeRevision] = createSignal(0);
    const mood = () => (moods.has(props.mood) ? props.mood : "idle");
    const size = () => (Number.isFinite(props.size) && props.size > 0 ? props.size : 120);
    const reducedMotion = createMediaQuery("(prefers-reduced-motion: reduce)");
    const documentVisible = createDocumentVisibility();
    let animationFrame = 0;
    let visible = true;
    let canvas: HTMLCanvasElement | undefined;
    const shouldAnimate = () =>
      canvas?.isConnected &&
      branding.read().brandIcon === "claw" &&
      visible &&
      !reducedMotion() &&
      documentVisible();
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
      drawPose(reducedMotion() ? staticMascotPose(mood()) : animator.poseAt(time));
    const renderFrame = (timestamp: number) => {
      animationFrame = 0;
      if (!shouldAnimate()) {
        return;
      }
      draw(timestamp / 1_000);
      animationFrame = window.requestAnimationFrame(renderFrame);
    };
    const syncPlayback = () => {
      if (!shouldAnimate()) {
        stopAnimation();
        if (reducedMotion()) {
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
    createEffect(() => [reducedMotion(), documentVisible()], syncPlayback);
    createIntersectionObserver(
      () => [host],
      (entries) => {
        visible = entries.some((entry) => entry.isIntersecting);
        syncPlayback();
      },
    );
    onSettled(() => {
      const themeObserver = new MutationObserver(() => setThemeRevision((value) => value + 1));
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme-mode", "data-theme-mascot"],
      });
      draw(performance.now() / 1_000);
      syncPlayback();
      return () => {
        themeObserver.disconnect();
      };
    });
    onCleanup(stopAnimation);
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
