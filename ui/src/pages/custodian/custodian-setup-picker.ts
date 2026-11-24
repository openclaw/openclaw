import type { SystemAgentSetupDetectResult as SetupDetection } from "../../api/types.ts";
import type { SetupAuthOption, SetupCandidate } from "./custodian-auto-setup.ts";

export type RowId = "chatgpt" | "claude" | "gemini" | "api-key" | "local" | `found:${string}`;
type RowAction =
  | { type: "candidate"; candidate: SetupCandidate }
  | { type: "sign-in"; option: SetupAuthOption }
  | { type: "api-key"; providerId?: string }
  | { type: "local" };
export type Row = { id: RowId; action: RowAction; detected: boolean };

const LOCAL_PROVIDERS = new Set(["ollama", "lmstudio", "llama-cpp"]);
const isLocalProvider = (provider: string) => LOCAL_PROVIDERS.has(provider.toLowerCase());
export const PLACEHOLDER_ROWS: RowId[] = ["chatgpt", "claude", "gemini", "api-key", "local"];
/** The Mac's titles, subtitles and artwork for the fixed rows (custodian.autoSetup keys). */
export const ROW_COPY: Partial<Record<RowId, { name: string; body: string; brand?: string }>> = {
  chatgpt: { name: "chatgpt", body: "chatgptBody", brand: "openai" },
  claude: { name: "claude", body: "claudeBody", brand: "claude" },
  gemini: { name: "gemini", body: "geminiKeyBody", brand: "google" },
  "api-key": { name: "apiKey", body: "apiKeyBody" },
  local: { name: "localModel", body: "localModelBody" },
};

/**
 * Groups the Gateway's choices into the Mac's picker rows. Presentation only: the Gateway
 * still owns detection, sign-in, activation and the test.
 */
export function setupPicker(detection: SetupDetection) {
  // Utility-only choices (a setup helper model) cannot finish first-run setup on their own.
  const primary = <T extends { modelTarget?: "utility" }>(entries: T[] | undefined) =>
    (entries ?? []).filter((entry) => entry.modelTarget !== "utility");
  const authOptions = primary(detection.authOptions);
  const manualProviders = primary(detection.manualProviders);
  const prepareOptions = primary(detection.prepareOptions);
  const usable = primary(detection.candidates).filter((entry) => entry.credentials !== false);
  const local = usable.filter((entry) => isLocalProvider(entry.modelRef.split("/")[0] ?? ""));
  const localAuthOptions = authOptions.filter((option) =>
    isLocalProvider(option.brandId ?? option.id),
  );
  const claimed = new Set(local.map((entry) => entry.kind));
  const used = new Set(localAuthOptions.map((option) => option.id));
  const rows: Row[] = [];
  const account = (id: RowId, kind: string, brand: string, allowsInstall: boolean) => {
    const candidate = usable.find((entry) => entry.kind === kind);
    if (candidate) {
      claimed.add(candidate.kind);
      rows.push({ id, action: { type: "candidate", candidate }, detected: true });
      return true;
    }
    const kinds = allowsInstall ? ["oauth", "device-code", "install"] : ["oauth", "device-code"];
    const options = authOptions.filter(
      (option) => option.brandId === brand && kinds.includes(option.kind),
    );
    // Gateway order already ranks options; a browser sign-in beats a device code.
    const option = options.find((entry) => entry.kind === "oauth") ?? options[0];
    if (!option) {
      return false;
    }
    used.add(option.id);
    rows.push({ id, action: { type: "sign-in", option }, detected: false });
    return true;
  };
  account("chatgpt", "codex-cli", "openai", false);
  account("claude", "claude-cli", "anthropic", true);
  if (!account("gemini", "gemini-cli", "google", false)) {
    const key = manualProviders.find((provider) => provider.brandId === "google");
    if (key) {
      rows.push({ id: "gemini", action: { type: "api-key", providerId: key.id }, detected: false });
    }
  }
  if (manualProviders.length) {
    rows.push({ id: "api-key", action: { type: "api-key" }, detected: false });
  }
  const installs = detection.recommendedInstalls ?? [];
  const localApps = new Set(
    [...local.map((entry) => entry.brandId ?? ""), ...prepareOptions.map((o) => o.brandId ?? o.id)]
      .filter(Boolean)
      .map((id) => id.toLowerCase()),
  );
  // A download only for a local app the card cannot already use or connect.
  const localDownloads = installs.filter((install) => {
    const id = (install.brandId ?? install.id).toLowerCase();
    return isLocalProvider(id) && !localApps.has(id);
  });
  if (local.length || localAuthOptions.length || prepareOptions.length || localDownloads.length) {
    rows.push({ id: "local", action: { type: "local" }, detected: local.length > 0 });
  }
  const found: Row[] = usable
    .filter((entry) => !claimed.has(entry.kind))
    .map((candidate) => ({
      id: `found:${candidate.kind}`,
      action: { type: "candidate", candidate },
      detected: true,
    }));
  return {
    rows: [...found, ...rows],
    manualProviders,
    prepareOptions,
    local,
    localAuthOptions,
    localDownloads,
    moreAuthOptions: authOptions.filter((option) => !used.has(option.id)),
    otherInstalls: installs.filter((install) => !isLocalProvider(install.brandId ?? install.id)),
    chatgptSignIn: authOptions.find(
      (option) =>
        option.brandId === "openai" && (option.kind === "oauth" || option.kind === "device-code"),
    ),
  };
}
