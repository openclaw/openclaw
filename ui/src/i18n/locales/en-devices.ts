import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Devices-page and pairing-dialog copy follows those lazy consumers, rather
// than making every Control UI startup pay for controls it may never open.
const enDevices = {
  devices: {
    pairing: {
      subtitle: "Create a secure setup for a mobile app or node host.",
      noApp: "Don't have the app yet?",
      getApps: "Get the apps",
      generating: "Creating a secure setup code…",
      accessTitle: "Setup type",
      fullAccess: "Full access (recommended)",
      fullAccessHint:
        "Device capabilities plus complete Gateway controls, including settings and upgrades.",
      limitedAccess: "Limited access",
      limitedAccessHint:
        "Device capabilities, chat, and approvals without administrative controls.",
      nodeAccess: "Node host",
      nodeAccessHint: "Connect a computer as a command and capability host.",
      generateCode: "Create setup code",
      transportLimitedTitle: "Limited for network safety",
      transportLimitedHint:
        "This Gateway URL uses plaintext ws://. Use wss:// or Tailscale Serve, then create a new code for full access.",
      failed: "Could not create a setup code.",
      statusFailed: "Could not verify whether pairing completed.",
      qrAlt: "OpenClaw mobile pairing QR code",
      qrUnavailable: "QR unavailable. Copy the setup code instead.",
      copySetupCode: "Copy setup code",
      nodeExpiresIn: "This setup link expires in {time}.",
      nodeExpired: "This setup link has expired. Create a new one.",
      newCode: "New code",
      showSetupCode: "Show setup code",
      pending: "Device requests waiting for review: {count}",
      review: "Review",
      waiting: "Official OpenClaw mobile apps connect automatically after scanning.",
      pairedTitle: "Device paired",
      deliveryUncertainTitle: "Pairing delivery could not be confirmed",
      deliveryUncertainHint:
        "The setup code is retired, but the device may not have received its credential. Check Manage devices, remove the device if needed, then create a new code.",
      fullAccessSummary: "Full access",
      nodeAccessSummary: "Node access",
      done: "Done",
      expiredTitle: "Setup code expired",
      generateNewCode: "Generate new code",
      nodeWaiting: "Run the command on the device, then review its pairing request here.",
      help: "Pairing help",
      helpNewTab: "Pairing help (opens in a new tab)",
      manageDevices: "Manage devices",
    },
    capabilities: {
      browser: { label: "Browser", description: "Browse and interact with web pages." },
      canvas: { label: "Canvas", description: "Present and interact with visual content." },
      screen: { label: "Screen", description: "Capture or record the screen." },
      computer: {
        label: "Computer",
        description: "Control desktop applications with the mouse and keyboard.",
      },
      file: { label: "Files", description: "Read and manage files on this device." },
      system: { label: "System", description: "Run commands and inspect this device." },
      mcp: { label: "MCP", description: "Use tools provided by MCP servers on this device." },
      localInference: {
        label: "Local inference",
        description: "Run models locally on this device.",
      },
      camera: { label: "Camera", description: "Capture photos and video with the device camera." },
      talk: { label: "Talk", description: "Have voice conversations through this device." },
      location: { label: "Location", description: "Read the device location." },
      notifications: {
        label: "Notifications",
        description: "Read and manage device notifications.",
      },
      contacts: { label: "Contacts", description: "Find and manage contacts." },
      calendar: { label: "Calendar", description: "Read and manage calendar events." },
      reminders: { label: "Reminders", description: "Read and manage reminders." },
      device: { label: "Device", description: "Read device information and status." },
      photos: { label: "Photos", description: "Browse the device photo library." },
      sms: { label: "SMS", description: "Read and send text messages." },
      health: { label: "Health", description: "Read health and fitness data." },
      motion: { label: "Motion", description: "Read movement and activity data." },
      runtime: "1 runtime",
      runtimes: "{count} runtimes",
      overflow: "{count} more capabilities",
    },
  },
} satisfies TranslationMap;

export const registerDevicesEnglish = Object.assign(
  () => {
    en.devices.capabilities = enDevices.devices.capabilities;
    Object.assign(en.devices.pairing, enDevices.devices.pairing);
  },
  { catalog: enDevices },
);
