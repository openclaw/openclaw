import { PWA_ICON_SIZE } from "../../../src/gateway/pwa-icon-contract.js";
import {
  readAvatarGatewayContext,
  registerAvatarGatewayReset,
} from "../lib/identity-avatar-context.ts";
import { resolveAvatarImageUrl, retainAvatarImageUrl } from "../lib/identity-avatar-loader.ts";
import { loadOrCreateDeviceIdentity } from "../lib/nodes/index.ts";
import { resolveControlUiPaths } from "./browser.ts";
import { fetchWithControlUiAuth } from "./control-ui-auth.ts";
import { selectPwaInstallIcon } from "./control-ui-document-head.ts";

export { currentPwaInstallIcon } from "./control-ui-document-head.ts";

export function resetPwaInstallIcon(): Promise<void> {
  return updatePwaInstallIcon(null);
}

async function squarePng(source: Blob | string): Promise<Blob> {
  if (
    source instanceof Blob &&
    (source.size > 10 * 1024 * 1024 ||
      !["image/png", "image/jpeg", "image/webp"].includes(source.type))
  ) {
    throw new Error("Choose a PNG, JPEG or WebP up to 10 MB");
  }
  const managed =
    typeof source === "string" && source.startsWith("/") ? resolveAvatarImageUrl(source) : null;
  const release = retainAvatarImageUrl(managed);
  const local = source instanceof Blob ? URL.createObjectURL(source) : null;
  try {
    const url =
      local ??
      (await managed) ??
      (typeof source === "string" &&
      (source.startsWith("data:image/") || source.startsWith("blob:"))
        ? source
        : null);
    if (!url) {
      throw new Error("Agent picture unavailable");
    }
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = PWA_ICON_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Image processing unavailable");
    }
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    ctx.drawImage(
      image,
      (image.naturalWidth - side) / 2,
      (image.naturalHeight - side) / 2,
      side,
      side,
      0,
      0,
      PWA_ICON_SIZE,
      PWA_ICON_SIZE,
    );
    const png = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/png");
    });
    if (!png) {
      throw new Error("Cannot encode install icon");
    }
    return png;
  } finally {
    release();
    if (local) {
      URL.revokeObjectURL(local);
    }
  }
}

export function savePwaInstallIcon(source: Blob | string): Promise<void> {
  return updatePwaInstallIcon(source);
}

async function updatePwaInstallIcon(source: Blob | string | null): Promise<void> {
  const gateway = readAvatarGatewayContext();
  if (gateway.origin !== window.location.origin) {
    throw new Error("Open this Gateway directly to customize its installed icon");
  }
  const controller = new AbortController();
  const stop = registerAvatarGatewayReset(() => controller.abort());
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
  try {
    const body = source === null ? undefined : await squarePng(source);
    const { deviceId } = await loadOrCreateDeviceIdentity();
    const base = resolveControlUiPaths(window.location.pathname)[1];
    const response = await fetchWithControlUiAuth(
      base + "/pwa-icon",
      {
        method: source === null ? "DELETE" : "POST",
        credentials: "same-origin",
        redirect: "error",
        headers: {
          ...(body ? { "Content-Type": "image/png" } : {}),
          "x-openclaw-install-device": deviceId,
        },
        body,
        signal,
      },
      gateway.authTokens,
      () => !signal.aborted,
    );
    if (!response.ok) {
      throw new Error(`Could not save install icon (HTTP ${response.status})`);
    }
    if (source === null) {
      selectPwaInstallIcon(null);
      return;
    }
    const receipt: unknown = await response.json();
    signal.throwIfAborted();
    if (
      !receipt ||
      typeof receipt !== "object" ||
      !("iconUrl" in receipt) ||
      typeof receipt.iconUrl !== "string"
    ) {
      throw new Error("Invalid install icon receipt");
    }
    selectPwaInstallIcon(receipt.iconUrl);
  } finally {
    stop();
  }
}
