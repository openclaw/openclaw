import { PWA_ICON_SIZE } from "../../../src/gateway/pwa-icon-contract.js";
import { t } from "../i18n/index.ts";
import {
  readAvatarGatewayContext,
  registerAvatarGatewayReset,
} from "../lib/identity-avatar-context.ts";
import { resolveAvatarImageUrl, retainAvatarImageUrl } from "../lib/identity-avatar-loader.ts";
import { loadOrCreateDeviceIdentity } from "../lib/nodes/index.ts";
import { fetchWithControlUiAuth, readControlUiJsonResponse } from "./control-ui-auth.ts";
import { installIconSelection, selectPwaInstallIcon } from "./pwa-install-selection.ts";

export function resetPwaInstallIcon(): Promise<void> {
  return updatePwaInstallIcon(null);
}

async function squarePng(source: Blob | string): Promise<Blob> {
  if (
    source instanceof Blob &&
    (source.size > 10 * 1024 * 1024 ||
      !["image/png", "image/jpeg", "image/webp"].includes(source.type))
  ) {
    throw new Error(t("configView.appearance.installIcon.chooseImage"));
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
      throw new Error(t("configView.appearance.installIcon.noPicture"));
    }
    const image = new Image();
    image.src = url;
    try {
      await image.decode();
    } catch {
      throw new Error(t("configView.appearance.installIcon.chooseImage"));
    }
    if (!image.naturalWidth || !image.naturalHeight) {
      throw new Error(t("configView.appearance.installIcon.chooseImage"));
    }
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = PWA_ICON_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error(t("configView.appearance.installIcon.chooseImage"));
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
      throw new Error(t("configView.appearance.installIcon.chooseImage"));
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
  const owner = installIconSelection.owner;
  if (!owner || gateway.origin !== window.location.origin) {
    throw new Error(t("configView.appearance.installIcon.signIn"));
  }
  const controller = new AbortController();
  const stop = registerAvatarGatewayReset(() => controller.abort());
  const signal = AbortSignal.any([
    controller.signal,
    owner.controller.signal,
    AbortSignal.timeout(30_000),
  ]);
  try {
    const body = source === null ? undefined : await squarePng(source);
    const { deviceId } = await loadOrCreateDeviceIdentity();
    const base = owner.basePath;
    const response = await fetchWithControlUiAuth(
      base + "/pwa-icon",
      {
        method: source === null ? "DELETE" : "POST",
        credentials: "same-origin",
        redirect: "error",
        headers: {
          ...(body ? { "Content-Type": "image/png" } : {}),
          "x-openclaw-install-device": deviceId,
          "x-openclaw-install-profile": owner.profileId,
        },
        body,
        signal,
      },
      gateway.authTokens,
      () => !signal.aborted,
    );
    if (!response.ok) {
      const { data } = await readControlUiJsonResponse(response, signal);
      const code = data?.error;
      switch (response.status) {
        case 401:
          throw new Error(t("configView.appearance.installIcon.signIn"));
        case 403:
          throw new Error(
            code === "origin_not_allowed"
              ? t("configView.appearance.installIcon.origin")
              : code === "authenticated_profile_required"
                ? t("configView.appearance.installIcon.signIn")
                : t("configView.appearance.installIcon.writeAccess"),
          );
        case 409:
          throw new Error(t("configView.appearance.installIcon.signIn"));
        case 413:
        case 415:
          throw new Error(t("configView.appearance.installIcon.chooseImage"));
        case 400:
          throw new Error(
            code === "invalid_install_device"
              ? t("configView.appearance.installIcon.device")
              : t("configView.appearance.installIcon.chooseImage"),
          );
        case 429:
          throw new Error(t("configView.appearance.installIcon.busy"));
        case 507:
          throw new Error(t("configView.appearance.installIcon.full"));
        default:
          throw new Error(
            t("configView.appearance.installIcon.httpFailed", { status: String(response.status) }),
          );
      }
    }
    if (source === null) {
      selectPwaInstallIcon(owner, null);
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
    selectPwaInstallIcon(owner, receipt.iconUrl);
  } finally {
    stop();
  }
}
