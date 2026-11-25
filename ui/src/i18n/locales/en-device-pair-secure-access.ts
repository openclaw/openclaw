import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Only the pairing dialog shows this, and only for a loopback-only Gateway, so it
// loads with the dialog instead of the devices copy that startup registers.
const enDevicePairSecureAccess = {
  devices: {
    pairing: {
      secureAccess: {
        title: "Set up secure access",
        intro:
          "Your phone can’t reach OpenClaw yet. Right now it only accepts connections from this computer.",
        tailscaleTitle: "Use Tailscale (recommended)",
        tailscaleSteps:
          "The Gateway still listens only on this computer. Tailscale Serve gives permitted devices on your tailnet encrypted access. Install Tailscale on this computer and your phone and sign in on both. Then run this command and restart the Gateway.",
        tailscaleGuide: "Tailscale setup guide",
        lanTitle: "Use your home Wi‑Fi instead",
        lanWarning:
          "Only on a network you trust. The connection isn’t encrypted, so others on the network can see it, and OpenClaw stays reachable on any network this computer joins. Phones get Limited access, which still includes chat history and approvals. Run this command, then restart the Gateway.",
        lanUndo:
          "To undo, run {command}, restart OpenClaw, and remove devices you no longer want in Manage devices.",
        afterRestart:
          "After the Dashboard reconnects, reopen Connect a device and choose Create setup code.",
        publicTitle: "Use a public HTTPS address",
        publicHint:
          "If you already run one, set gateway.publicOrigin to it, or set the device-pair plugin’s publicUrl.",
      },
    },
  },
} satisfies TranslationMap;

export const registerDevicePairSecureAccessEnglish = Object.assign(
  () => {
    Object.assign(en.devices.pairing, enDevicePairSecureAccess.devices.pairing);
  },
  { catalog: enDevicePairSecureAccess },
);
