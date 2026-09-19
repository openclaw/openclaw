import { z } from "zod";

export const nativeChromeExtensionSetupActionSchema = z.enum(["inspect", "install", "verify"]);
export type NativeChromeExtensionSetupAction = z.infer<
  typeof nativeChromeExtensionSetupActionSchema
>;
export const nativeChromeExtensionSetupResultSchema = z.object({
  action: nativeChromeExtensionSetupActionSchema,
  target: z.object({
    kind: z.literal("local-host"),
    platform: z.enum(["darwin", "linux", "win32"]),
    hostname: z.string().min(1).max(255),
    profile: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    relayPort: z.number().int().min(1).max(65535),
  }),
  phase: z.enum([
    "inspection_required",
    "preparing",
    "needs_browser_action",
    "waiting_for_connection",
    "ready",
    "blocked",
  ]),
  reason: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
  installation: z.object({
    nativeHostRegistered: z.boolean(),
    installRequested: z.boolean(),
    discoveredProfiles: z.number().int().nonnegative(),
    awaitingApproval: z.boolean(),
    automaticBootstrapSupported: z.boolean(),
  }),
  connection: z.object({
    state: z.enum(["not_checked", "unavailable", "waiting_for_extension", "connected"]),
    extensionVersion: z.string().max(128).optional(),
  }),
  nextAction: z.enum([
    "none",
    "install",
    "open_chrome",
    "approve_extension",
    "install_from_store",
    "check_connection",
    "repair_native_host",
    "unsupported",
  ]),
});
export type NativeChromeExtensionSetupResult = z.infer<
  typeof nativeChromeExtensionSetupResultSchema
>;

export type NativeChromeSetupCapability = {
  setupChromeExtension(
    action: NativeChromeExtensionSetupAction,
  ): Promise<NativeChromeExtensionSetupResult>;
  dispose(): void;
};

type NativeChromeSetupWindow = Window & {
  webkit?: {
    messageHandlers?: {
      openclawChromeSetup?: {
        postMessage: (message: { action: NativeChromeExtensionSetupAction }) => Promise<unknown>;
      };
    };
  };
};

/** Desktop hosts own local setup; presence alone never starts an operation. */
export function createNativeChromeSetupCapability(): NativeChromeSetupCapability | null {
  if (typeof window === "undefined") {
    return null;
  }
  // SAFETY: native hosts add optional WebKit fields; handler presence and every reply are validated below.
  const nativeWindow = window as NativeChromeSetupWindow;
  const handler = nativeWindow.webkit?.messageHandlers?.openclawChromeSetup;
  if (typeof handler?.postMessage !== "function") {
    return null;
  }
  const postMessage = handler.postMessage;
  let disposed = false;
  const isCurrent = () =>
    !disposed &&
    nativeWindow.webkit?.messageHandlers?.openclawChromeSetup === handler &&
    handler.postMessage === postMessage;
  return {
    async setupChromeExtension(action) {
      if (!isCurrent()) {
        throw new Error("Native Chrome setup is unavailable");
      }
      const validatedAction = nativeChromeExtensionSetupActionSchema.parse(action);
      const reply = await postMessage.call(handler, { action: validatedAction });
      const result = nativeChromeExtensionSetupResultSchema.safeParse(reply);
      if (!isCurrent() || !result.success || result.data.action !== action) {
        throw new Error("Native Chrome setup returned an invalid result");
      }
      return result.data;
    },
    dispose() {
      disposed = true;
    },
  };
}
