import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { gatewayCredentialScope } from "../../packages/gateway-client/src/gateway-origin-scope.js";
import { formatCliCommand } from "../cli/command-format.js";
import { ConfigMutationConflictError, replaceConfigFile } from "../config/config.js";
import { readConfigFileSnapshot } from "../config/io.js";
import { logConfigUpdated } from "../config/logging.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { preserveGatewaySshRemotePort } from "../gateway/connection-details.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime, writeRuntimeJson } from "../runtime.js";
import { createGatewayEnvSecretRef } from "../secrets/ref-contract.js";
import { withOpenClawStateLease } from "../state/openclaw-state-lease.js";
import { withSetupMigrationTargetLock } from "../wizard/setup.migration-snapshot.js";
import { createNonInteractiveLoggingPrompter } from "./non-interactive-prompter.js";
import { applySkipBootstrapConfig } from "./onboard-config.js";
import { applyWizardMetadata } from "./onboard-helpers.js";
import { commitNonInteractiveOnboardConfig } from "./onboard-non-interactive/config-write.js";
import { runNonInteractiveLocalSetup } from "./onboard-non-interactive/local.js";
import { rejectOnboardingOption } from "./onboard-options.js";
import type { OnboardOptions } from "./onboard-types.js";

function isMigrationImport(opts: OnboardOptions): boolean {
  return Boolean(
    opts.importFrom || opts.importSource || opts.importSecrets || opts.flow === "import",
  );
}

/** Runs a setup migration import with non-interactive prompt failures. */
async function runNonInteractiveMigrationImport(params: {
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  baseConfig: OpenClawConfig;
}) {
  const providerId = params.opts.importFrom?.trim();
  if (!providerId) {
    // Migration import cannot safely prompt in non-interactive mode; require the
    // provider id so the import path is deterministic.
    rejectOnboardingOption(
      params.opts,
      params.runtime,
      `--import-from is required for non-interactive migration import. Run ${formatCliCommand("openclaw migrate list")} to choose a provider.`,
    );
    return;
  }
  const { detectSetupMigrationSources, runSetupMigrationImport } =
    await import("../wizard/setup.migration-import.js");
  const discovery = await detectSetupMigrationSources({
    config: params.baseConfig,
    runtime: params.runtime,
  });
  const readValidSnapshot = async () => {
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      throw new Error(
        "Migration target config became invalid. Run `openclaw doctor --fix` to apply supported repairs.",
      );
    }
    return snapshot;
  };
  const outcome = await runSetupMigrationImport({
    opts: { ...params.opts, importFrom: providerId, nonInteractive: true },
    baseConfig: params.baseConfig,
    ...discovery,
    prompter: createNonInteractiveLoggingPrompter(
      params.runtime,
      (message) =>
        `Non-interactive migration import needs explicit flags before prompting: ${message}`,
    ),
    runtime: params.runtime,
    async readConfigFile() {
      const snapshot = await readValidSnapshot();
      return snapshot.exists ? (snapshot.sourceConfig ?? snapshot.config) : {};
    },
    async commitConfigFile(config, expectedConfig) {
      const latest = await readValidSnapshot();
      const latestConfig = latest.exists ? (latest.sourceConfig ?? latest.config) : {};
      if (!isDeepStrictEqual(latestConfig, expectedConfig)) {
        throw new ConfigMutationConflictError("config changed during migration promotion");
      }
      const committed = await replaceConfigFile({
        sourceConfig: config,
        snapshot: latest,
        ...(latest.hash !== undefined ? { baseHash: latest.hash } : {}),
        writeOptions: { allowConfigSizeDrop: true },
      });
      logConfigUpdated(params.runtime);
      return committed.nextConfig;
    },
  });
  if (outcome.kind === "back") {
    throw new Error("Non-interactive migration import cannot navigate back.");
  }
  await outcome.acknowledgePromotion?.();
}

async function runNonInteractiveSetupExclusive(opts: OnboardOptions, runtime: RuntimeEnv) {
  const snapshot = await readConfigFileSnapshot();
  if (snapshot.exists && !snapshot.valid) {
    // Avoid rewriting an invalid config snapshot; doctor owns recovery so setup
    // does not erase malformed user state.
    rejectOnboardingOption(
      opts,
      runtime,
      `Config invalid. Run \`${formatCliCommand("openclaw doctor --fix")}\` to apply supported repairs, then re-run setup.`,
    );
    return;
  }

  const baseConfig: OpenClawConfig =
    snapshot.valid && snapshot.exists ? (snapshot.sourceConfig ?? snapshot.config) : {};
  const mode = opts.mode ?? "local";

  if (isMigrationImport(opts)) {
    // Import flow owns its own commit path because migrations may intentionally
    // shrink legacy config after extracting credentials.
    await runNonInteractiveMigrationImport({ opts, runtime, baseConfig });
    return;
  }

  if (mode === "remote") {
    const remoteUrl = normalizeOptionalString(opts.remoteUrl);
    const remoteToken = normalizeOptionalString(opts.remoteToken);
    const remotePassword = normalizeOptionalString(opts.remotePassword);
    const existingRemote = baseConfig.gateway?.remote;
    const remoteUrlChanged =
      gatewayCredentialScope(existingRemote?.url ?? "") !== gatewayCredentialScope(remoteUrl ?? "");
    // A remote block belongs to one endpoint. Reusing it for a different URL can
    // send old credentials or keep routing through the old SSH target.
    const preservedRemote = remoteUrlChanged
      ? {}
      : { ...existingRemote, ...preserveGatewaySshRemotePort(baseConfig, remoteUrl) };
    if (remoteToken) {
      delete preservedRemote.password;
    }
    if (remotePassword) {
      delete preservedRemote.token;
    }
    const remote = { ...preservedRemote, url: remoteUrl };
    if (remoteToken) {
      remote.token =
        opts.secretInputMode === "ref"
          ? createGatewayEnvSecretRef(baseConfig, "OPENCLAW_GATEWAY_TOKEN")
          : remoteToken;
    }
    if (remotePassword) {
      remote.password =
        opts.secretInputMode === "ref"
          ? createGatewayEnvSecretRef(baseConfig, "OPENCLAW_GATEWAY_PASSWORD")
          : remotePassword;
    }
    let nextConfig: OpenClawConfig = {
      ...baseConfig,
      gateway: {
        ...baseConfig.gateway,
        mode: "remote",
        remote,
      },
    };
    if (opts.skipBootstrap) {
      nextConfig = applySkipBootstrapConfig(nextConfig);
    }
    nextConfig = applyWizardMetadata(nextConfig, { command: "onboard", mode });
    await commitNonInteractiveOnboardConfig({
      nextConfig,
      baseConfig,
      baseHash: snapshot.hash,
      reset: opts.reset,
    });
    logConfigUpdated(runtime);

    const payload = {
      mode,
      remoteUrl,
      auth: nextConfig.gateway?.remote?.token
        ? "token"
        : nextConfig.gateway?.remote?.password
          ? ["pass", "word"].join("")
          : "none",
    };
    if (opts.json) {
      writeRuntimeJson(runtime, payload);
    } else {
      runtime.log(`Remote gateway: ${remoteUrl}`);
      runtime.log(`Auth: ${payload.auth}`);
      runtime.log(
        `Tip: run \`${formatCliCommand("openclaw configure --section web")}\` to store your Brave API key for web_search. Docs: https://docs.openclaw.ai/tools/web`,
      );
    }
    return;
  }

  await runNonInteractiveLocalSetup({
    opts,
    runtime,
    baseConfig,
    sourceConfigBeforeMigrations: snapshot.sourceConfigBeforeMigrations ?? {},
    baseHash: snapshot.hash,
  });
}

export async function runNonInteractiveSetup(
  opts: OnboardOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  await withSetupMigrationTargetLock(resolveStateDir(), async () => {
    if (isMigrationImport(opts)) {
      // Migration must inspect freshness before opening the shared lease DB.
      await runNonInteractiveSetupExclusive(opts, runtime);
      return;
    }
    await withOpenClawStateLease(
      {
        scope: "core:onboarding",
        key: "global",
        database: { scope: "shared" },
        // Bound one run to five minutes while allowing one predecessor to finish.
        leaseMs: 5 * 60_000,
        waitMs: 10 * 60_000,
        leaseLabel: "non-interactive onboarding lease",
        operationLabel: "onboarding.non-interactive.lease",
      },
      () => withPluginLifecycleLease({}, () => runNonInteractiveSetupExclusive(opts, runtime)),
    );
  });
}
