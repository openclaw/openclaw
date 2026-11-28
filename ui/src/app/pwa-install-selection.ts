import { parsePwaIconRoute } from "../../../src/gateway/pwa-icon-contract.js";
import { createChangeListeners } from "../../../src/shared/listeners.js";
import type { GatewayHelloOk } from "../api/gateway.ts";
import { listen } from "../lib/reactive/listener.ts";
import { getSafeLocalStorage } from "../local-storage.ts";
import type { ApplicationGateway } from "./gateway.ts";
import { inferControlUiPublicAssetPath } from "./public-assets.ts";

type IconOwner = {
  basePath: string;
  profileId: string;
  storageKey: string;
  hello: GatewayHelloOk;
  controller: AbortController;
};

const changes = createChangeListeners({ snapshot: true });
let owner: IconOwner | null = null;

export const installIconSelection = {
  subscribe: changes.subscribe,
  get owner() {
    return owner;
  },
  get icon() {
    if (!owner) {
      return null;
    }
    try {
      const path = getSafeLocalStorage()?.getItem(owner.storageKey);
      return path && isInstallIconPath(path, owner.basePath) ? path : null;
    } catch {
      return null;
    }
  },
};

function isInstallIconPath(path: string, basePath: string): boolean {
  const route = parsePwaIconRoute(path, basePath);
  return route?.kind === "asset" && route.size === 512;
}

function publishSelection(): void {
  applyInstallLinks();
  changes.publish();
}

export function bindInstallIconProfile(
  gateway: ApplicationGateway,
  basePath: string,
  isDocumentGateway: () => boolean,
): () => void {
  const sync = () => {
    const { phase, hello, selfUser } = gateway.snapshot;
    const profileId =
      phase === "connected" &&
      hello &&
      selfUser?.identity?.type === "profile" &&
      isDocumentGateway()
        ? selfUser.identity.id
        : null;
    if (profileId && hello) {
      if (owner?.profileId === profileId && owner.hello === hello && owner.basePath === basePath) {
        return;
      }
      owner?.controller.abort();
      owner = {
        profileId,
        hello,
        basePath,
        controller: new AbortController(),
        storageKey: "openclaw.installIcon.v2:" + JSON.stringify([basePath, profileId]),
      };
    } else {
      if (!owner) {
        return;
      }
      owner.controller.abort();
      owner = null;
    }
    publishSelection();
  };
  const stop = gateway.subscribe(sync);
  const stopStorage = listen(window, "storage", (event) => {
    if (owner && (event.key === null || event.key === owner.storageKey)) {
      publishSelection();
    }
  });
  sync();
  return () => {
    stop();
    stopStorage();
    owner?.controller.abort();
    owner = null;
    publishSelection();
  };
}

export function selectPwaInstallIcon(expected: IconOwner, iconUrl: string | null): void {
  expected.controller.signal.throwIfAborted();
  const storage = getSafeLocalStorage();
  if (!storage) {
    throw new Error("Browser storage is unavailable");
  }
  if (iconUrl === null) {
    storage.removeItem(expected.storageKey);
  } else if (isInstallIconPath(iconUrl, expected.basePath)) {
    storage.setItem(expected.storageKey, iconUrl);
  } else {
    throw new Error("Invalid install icon receipt");
  }
  publishSelection();
}

function applyInstallLinks(): void {
  const icon = installIconSelection.icon;
  for (const [id, asset, custom] of [
    [
      "openclaw-apple-touch-icon",
      "apple-touch-icon.png",
      icon?.replace(/icon\.png$/u, "apple-touch-icon.png"),
    ],
    [
      "openclaw-manifest",
      "manifest.webmanifest",
      icon?.replace(/icon\.png$/u, "manifest.webmanifest"),
    ],
  ] as const) {
    const link = document.getElementById(id);
    if (link instanceof HTMLLinkElement) {
      link.href = custom ?? inferControlUiPublicAssetPath(asset);
    }
  }
}
