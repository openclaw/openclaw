import { isWSLSync } from "../infra/wsl.js";
import type { WizardPrompter } from "../wizard/prompts.js";

/**
 * Common base URLs for local model servers, adjusted for the current environment.
 *
 * When running inside WSL and connecting to a server on the Windows host,
 * `localhost` / `127.0.0.1` won't reach the host — the WSL2 VM has its own
 * network namespace.  We detect WSL and suggest the special hostname that
 * routes to the Windows host automatically.
 */

/** Resolve the Windows-host-reachable IP from inside WSL2. */
function resolveWslHostIp(): string | undefined {
  if (!isWSLSync()) {
    return undefined;
  }
  // WSL2 sets this env var pointing to the host; fall back to the standard
  // gateway address that the default WSL2 NAT provides.
  try {
    // In WSL2 ≥ 0.66 the host is always reachable at the DNS name below,
    // but older versions may need /etc/resolv.conf's nameserver.
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const nameserver = execSync("grep nameserver /etc/resolv.conf | head -1 | awk '{print $2}'", {
      encoding: "utf8",
      timeout: 2000,
    }).trim();
    return nameserver || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Adjust a localhost-style URL so it is reachable from the current environment.
 *
 * - Native Windows or native Linux: returns the URL unchanged.
 * - WSL accessing a Windows-hosted server: replaces 127.0.0.1/localhost with
 *   the WSL host gateway IP.
 */
export function adjustBaseUrlForEnvironment(url: string): string {
  if (!isWSLSync()) {
    return url;
  }
  const hostIp = resolveWslHostIp();
  if (!hostIp) {
    return url;
  }
  // Only replace loopback addresses — leave remote URLs untouched.
  return url
    .replace(/\/\/127\.0\.0\.1([:/])/, `//${hostIp}$1`)
    .replace(/\/\/localhost([:/])/, `//${hostIp}$1`);
}

/** Interactive prompt for a local provider base URL with environment-aware defaults. */
export async function resolveLocalProviderBaseUrl(params: {
  prompter: WizardPrompter;
  defaultUrl: string;
  providerName: string;
}): Promise<string> {
  const isWsl = isWSLSync();

  let environmentNote = "";
  let adjustedDefault = params.defaultUrl;

  if (isWsl) {
    const hostIp = resolveWslHostIp();
    if (hostIp) {
      adjustedDefault = adjustBaseUrlForEnvironment(params.defaultUrl);
      environmentNote = ` (WSL detected — using host IP ${hostIp})`;
    } else {
      environmentNote =
        " (WSL detected — if server is on Windows host, use the host's IP instead of 127.0.0.1)";
    }
  } else if (process.platform === "win32") {
    environmentNote = " (Windows detected)";
  }

  if (environmentNote) {
    await params.prompter.note(
      `Running on ${isWsl ? "WSL" : "Windows"}.\n` +
        `If your ${params.providerName} server runs on the ${isWsl ? "Windows host" : "same machine"}, ` +
        `the default URL should work.${isWsl ? "\nIf it runs inside WSL, use 127.0.0.1 instead." : ""}`,
      `Environment${environmentNote}`,
    );
  }

  const baseUrlRaw = await params.prompter.text({
    message: `${params.providerName} base URL`,
    initialValue: adjustedDefault,
    placeholder: adjustedDefault,
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });

  return String(baseUrlRaw ?? "").trim();
}

export type FallbackStrategy = "ordered" | "cost" | "round-robin";

export type ModelPriorityConfig = {
  strategy: FallbackStrategy;
  /** Model refs in priority order (highest first). */
  models: string[];
};

/** Interactive prompt for configuring model priority and fallback strategy. */
export async function promptModelPriority(params: {
  prompter: WizardPrompter;
  modelRefs: string[];
  existingFallbacks?: string[];
}): Promise<{
  primary: string;
  fallbacks: string[];
  strategy: FallbackStrategy;
}> {
  if (params.modelRefs.length === 0) {
    throw new Error("No models provided for priority configuration");
  }

  if (params.modelRefs.length === 1) {
    return {
      primary: params.modelRefs[0],
      fallbacks: [],
      strategy: "ordered",
    };
  }

  // Strategy selection
  const strategyChoice = await params.prompter.select({
    message: "Model fallback strategy",
    options: [
      {
        value: "ordered",
        label: "Ordered fallback",
        hint: "Try models in priority order; fall back on failure",
      },
      {
        value: "cost",
        label: "Cost-optimized",
        hint: "Prefer cheapest model first; fall back to more expensive on failure",
      },
      {
        value: "round-robin",
        label: "Round-robin",
        hint: "Distribute load across models; skip unavailable ones",
      },
    ],
  });
  const strategy = String(strategyChoice) as FallbackStrategy;

  // Primary model selection
  const primaryChoice = await params.prompter.select({
    message: "Primary model (highest priority)",
    options: params.modelRefs.map((ref) => ({
      value: ref,
      label: ref,
    })),
  });
  const primary = String(primaryChoice);

  // Remaining models become fallbacks — let user reorder
  const remainingModels = params.modelRefs.filter((ref) => ref !== primary);

  if (remainingModels.length === 0) {
    return { primary, fallbacks: [], strategy };
  }

  if (remainingModels.length === 1) {
    const useFallback = await params.prompter.confirm({
      message: `Use ${remainingModels[0]} as fallback?`,
      initialValue: true,
    });
    return {
      primary,
      fallbacks: useFallback ? remainingModels : [],
      strategy,
    };
  }

  // Multi-select for fallback ordering
  const fallbackSelection = await params.prompter.multiselect({
    message: "Select fallback models (in priority order)",
    options: remainingModels.map((ref) => ({
      value: ref,
      label: ref,
    })),
    initialValues: remainingModels,
    searchable: false,
  });

  const fallbacks = fallbackSelection.map((v) => String(v));

  return { primary, fallbacks, strategy };
}
