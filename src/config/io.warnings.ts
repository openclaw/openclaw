import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { VERSION } from "../version.js";
import { hashConfigRaw } from "./io.read-helpers.js";
import {
  loggedConfigWarningFingerprints,
  setBoundedConfigIoWarningEntry,
  warnedFutureTouchedVersions,
} from "./io.state.js";
import type { OpenClawConfig } from "./types.js";
import { shouldWarnOnTouchedVersion } from "./version.js";

export function logConfigWarningsOnce(params: {
  configPath: string;
  warnings: Array<{ path: string; message: string }>;
  logger: Pick<typeof console, "warn">;
}): void {
  if (params.warnings.length === 0) {
    loggedConfigWarningFingerprints.delete(params.configPath);
    return;
  }
  const details = params.warnings
    .map(
      (warning) =>
        `${sanitizeTerminalText(warning.path || "<root>")}: ${sanitizeTerminalText(warning.message)}`,
    )
    .join("; ");
  const fingerprint = hashConfigRaw(details);
  const repeated = loggedConfigWarningFingerprints.get(params.configPath) === fingerprint;
  setBoundedConfigIoWarningEntry(loggedConfigWarningFingerprints, params.configPath, fingerprint);
  if (!repeated) {
    params.logger.warn(`Config warnings: ${details}`);
  }
}

export function warnIfConfigFromFuture(
  cfg: OpenClawConfig,
  logger: Pick<typeof console, "warn">,
): void {
  const touched = cfg.meta?.lastTouchedVersion;
  if (!touched || !shouldWarnOnTouchedVersion(VERSION, touched)) {
    return;
  }
  if (warnedFutureTouchedVersions.check(touched)) {
    return;
  }
  logger.warn(
    [
      `Your OpenClaw config was written by version ${touched}, but this command is running ${VERSION}.`,
      "Check: `openclaw --version`, `which openclaw`, and `openclaw gateway status --deep`.",
      "If unexpected, update PATH so `openclaw` points to the version you want, or reinstall the Gateway service from that same OpenClaw install.",
    ].join("\n"),
  );
}
