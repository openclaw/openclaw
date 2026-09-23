import { css } from "lit";

export const imageLightboxStyles = css`
  :host {
    --image-lightbox-control-background: rgba(12, 16, 24, 0.64);
    --image-lightbox-control-background-hover: rgba(12, 16, 24, 0.78);
    display: contents;
  }

  :host-context([data-theme-mode="dark"]) {
    --image-lightbox-control-background: rgba(255, 255, 255, 0.16);
    --image-lightbox-control-background-hover: rgba(255, 255, 255, 0.22);
  }

  openclaw-modal-dialog {
    --openclaw-modal-width: 100vw;
    --openclaw-modal-max-width: 100vw;
    --openclaw-modal-max-height: 100dvh;
    --openclaw-modal-backdrop-filter: none;
  }

  .lightbox {
    width: 100vw;
    height: 100dvh;
    display: grid;
    grid-template-rows: minmax(0, 1fr);
    overflow: hidden;
  }

  .header {
    display: contents;
  }

  .actions {
    position: fixed;
    z-index: 1;
    top: max(16px, calc(12px + var(--safe-area-top, 0px)));
    right: max(16px, calc(12px + var(--safe-area-right, 0px)));
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .actions .action,
  .action.zoom-control {
    color: var(--media-foreground);
    background-color: var(--image-lightbox-control-background);
    -webkit-backdrop-filter: blur(16px) saturate(140%);
    backdrop-filter: blur(16px) saturate(140%);
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
  }

  .actions .action {
    border-radius: 999px;
    transition: background-color 180ms ease;
  }

  .actions .action:hover,
  .zoom-control:hover:not([aria-disabled="true"]) {
    background-color: var(--image-lightbox-control-background-hover);
  }

  .title {
    display: none;
  }

  .action {
    min-height: 36px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 12px;
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: #fff;
    font: inherit;
    font-size: 12px;
    font-weight: 650;
    text-decoration: none;
    text-shadow: 0 1px 3px rgba(0, 0, 0, 0.85);
  }

  .action:hover {
    background: color-mix(in srgb, var(--text) 10%, transparent);
  }

  .action:focus-visible {
    outline: 2px solid #fff;
    outline-offset: 2px;
  }

  .action:focus:not(:focus-visible) {
    outline: none;
  }

  .open-original {
    min-height: 44px;
  }

  .open-original-icon {
    display: none;
  }

  .close {
    width: 44px;
    height: 44px;
    padding: 0;
    color: rgba(255, 255, 255, 0.82);
  }

  .close svg {
    width: 17px;
    height: 17px;
    /* Shadow DOM: global icon stroke rules don't reach in here; without a
         stroke the open-path x icon renders invisible. */
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .stage {
    min-height: 0;
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    box-sizing: border-box;
    padding: 20px 20px 72px;
    overflow: hidden;
  }

  .stage--gallery {
    touch-action: none;
  }

  .slide {
    container-type: size;
    width: 100%;
    height: 100%;
    min-height: 0;
    min-width: 0;
    display: grid;
    place-items: center;
  }

  .navigation {
    position: fixed;
    z-index: 1;
    top: 50%;
    width: 44px;
    height: 44px;
    padding: 0;
    border-radius: 50%;
    transform: translateY(-50%);
    color: var(--media-foreground);
    background: var(--image-lightbox-control-background);
  }

  .navigation:hover:not([aria-disabled="true"]) {
    background: var(--image-lightbox-control-background-hover);
  }

  .navigation[aria-disabled="true"] {
    opacity: 0.35;
  }

  .previous {
    inset-inline-start: max(12px, var(--safe-area-left, 0px));
  }

  .next {
    inset-inline-end: max(12px, var(--safe-area-right, 0px));
  }

  .navigation svg {
    width: 20px;
    height: 20px;
  }

  .navigation:dir(rtl) svg {
    transform: scaleX(-1);
  }

  .gallery-counter,
  .gallery-error {
    position: fixed;
    z-index: 1;
    margin: 0;
    padding: 6px 12px;
    border-radius: 999px;
    color: var(--media-foreground);
    background: var(--image-lightbox-control-background);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .gallery-counter {
    top: max(24px, calc(20px + var(--safe-area-top, 0px)));
    inset-inline-start: max(16px, calc(12px + var(--safe-area-left, 0px)));
  }

  .gallery-error {
    bottom: max(68px, calc(64px + var(--safe-area-bottom, 0px)));
    left: 50%;
    transform: translateX(-50%);
    max-width: calc(100vw - 48px);
  }

  @media (hover: hover) and (pointer: fine) {
    .navigation {
      opacity: 0;
      transition: opacity 180ms ease;
    }

    .lightbox:hover .navigation,
    .lightbox:focus-within .navigation {
      opacity: 1;
    }

    .lightbox:hover .navigation[aria-disabled="true"],
    .lightbox:focus-within .navigation[aria-disabled="true"] {
      opacity: 0.35;
    }
  }

  .image,
  .video {
    display: block;
    min-width: 0;
    min-height: 0;
    max-width: 100%;
    max-height: 100%;
    height: auto;
    object-fit: contain;
  }

  .image {
    width: auto;
    cursor: zoom-in;
    -webkit-user-drag: none;
  }

  .video {
    width: min(1280px, 100%);
    background: var(--media-bg);
  }

  .image.zoomed {
    cursor: grab;
  }

  .zoom-controls {
    position: fixed;
    z-index: 1;
    bottom: max(14px, calc(10px + var(--safe-area-bottom, 0px)));
    left: 50%;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    transform: translateX(-50%);
  }

  .zoom-control {
    min-width: 40px;
    min-height: 40px;
    padding: 0 10px;
    border: 0;
    font-size: 15px;
  }

  .zoom-control[aria-disabled="true"] {
    color: rgba(255, 255, 255, 0.8);
  }

  .zoom-level {
    min-width: 58px;
    font-size: 11px;
  }

  @media (max-width: 768px),
    (max-width: 932px) and (max-height: 500px) and (orientation: landscape) {
    openclaw-modal-dialog {
      --openclaw-modal-width: 100vw;
      --openclaw-modal-max-width: 100vw;
      --openclaw-modal-max-height: 100dvh;
    }

    .lightbox {
      width: 100vw;
      height: 100dvh;
    }

    .stage {
      padding: calc(68px + var(--safe-area-top, 0px)) calc(12px + var(--safe-area-right, 0px))
        calc(64px + var(--safe-area-bottom, 0px)) calc(12px + var(--safe-area-left, 0px));
    }

    .open-original {
      width: 44px;
      padding: 0;
    }

    .open-original-label {
      display: none;
    }

    .open-original-icon {
      display: inline-flex;
    }

    .open-original-icon svg {
      width: 17px;
      height: 17px;
    }

    .zoom-control {
      min-width: 44px;
      min-height: 44px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    openclaw-modal-dialog {
      --show-duration: 0ms;
      --hide-duration: 0ms;
    }

    .actions .action,
    .navigation {
      transition: none;
    }
  }
`;
