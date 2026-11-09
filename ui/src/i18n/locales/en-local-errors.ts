import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Native and notification details are optional; keep their copy out of startup.
const enLocalErrors = {
  runtimeErrors: {
    nativeCredential: "The app returned an invalid Gateway credential. Reconnect in the app.",
    nativeAuthorization: "The app returned an invalid Gateway authorization. Reconnect in the app.",
    nativeGateway: "This dashboard belongs to a different Gateway. Select the Gateway in the app.",
    nativeUnavailable:
      "Native Gateway authorization is unavailable. Reopen this dashboard in the app.",
    nativeChallenge: "The Gateway did not provide a valid native authentication challenge.",
    nativeTimeout: "The app did not authorize this dashboard in time. Reconnect in the app.",
    nativeClosed: "Native dashboard document closed",
  },
  notificationErrors: {
    gatewayChanged: "Gateway changed before the notification change could be saved.",
    manageDenied: "Your Gateway access does not allow managing browser notifications.",
    readDenied: "Your Gateway access does not allow reading notification preferences.",
    vapidKey:
      "Couldn’t retrieve the VAPID public key. Check the Gateway connection and try enabling notifications again.",
    serviceWorkerTimeout: "Service worker not ready (timed out)",
    unavailable:
      "Web Push is unavailable in this browser. On iPhone or iPad, add OpenClaw to the Home Screen and open the installed app.",
    enableFirst: "Enable notifications before changing notification preferences.",
    vapidMismatch:
      "This browser push subscription belongs to another Gateway. Open this Gateway’s own Control UI, or configure every mutually trusted Gateway behind this PWA with the same VAPID keypair.",
    permission: "Notification permission {permission}",
  },
  nativeDeviceEditError: "Native settings returned an invalid edit result",
} satisfies TranslationMap;

export const registerLocalErrorsEnglish = Object.assign(
  () => {
    Object.assign(en.runtimeErrors, enLocalErrors.runtimeErrors);
    en.notificationErrors = enLocalErrors.notificationErrors;
    en.nativeDeviceEditError = enLocalErrors.nativeDeviceEditError;
  },
  { catalog: enLocalErrors },
);
