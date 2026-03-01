import type { Command } from "commander";
import qrcode from "qrcode-terminal";
import { loadConfig } from "../config/config.js";
import { resolvePairingSetupFromConfig, encodePairingSetupCode } from "../pairing/setup-code.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";

type QrCliOptions = {
  json?: boolean;
  setupCodeOnly?: boolean;
  ascii?: boolean;
  remote?: boolean;
  url?: string;
  publicUrl?: string;
  token?: string;
  password?: string;
};

function renderQrAscii(data: string): Promise<string> {
  return new Promise((resolve) => {
    qrcode.generate(data, { small: true }, (output: string) => {
      resolve(output);
    });
  });
}

function readDevicePairPublicUrlFromConfig(cfg: ReturnType<typeof loadConfig>): string | undefined {
  const value = cfg.plugins?.entries?.["device-pair"]?.config?.["publicUrl"];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function registerQrCli(program: Command) {
  program
    .command("qr")
    .description("Generate an iOS pairing QR code and setup code")
    .addHelpText(
      "after",
      () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/qr", "docs.openclaw.ai/cli/qr")}\n`,
    )
    .option(
      "--remote",
      "Use gateway.remote.url and gateway.remote token/password (ignores device-pair publicUrl)",
      false,
    )
    .option("--url <url>", "Override gateway URL used in the setup payload")
    .option("--public-url <url>", "Override gateway public URL used in the setup payload")
    .option("--token <token>", "Override gateway token for setup payload")
    .option("--password <password>", "Override gateway password for setup payload")
    .option("--setup-code-only", "Print only the setup code", false)
    .option("--no-ascii", "Skip ASCII QR rendering")
    .option("--json", "Output JSON", false)
    .action(async (opts: QrCliOptions) => {
      try {
        if (opts.token && opts.password) {
          throw new Error("Use either --token or --password, not both.");
        }

        const loaded = loadConfig();
        const cfg = {
          ...loaded,
          gateway: {
            ...loaded.gateway,
            auth: {
              ...loaded.gateway?.auth,
            },
          },
        };

        const token = typeof opts.token === "string" ? opts.token.trim() : "";
        const password = typeof opts.password === "string" ? opts.password.trim() : "";
        const wantsRemote = opts.remote === true;
        if (token) {
          cfg.gateway.auth.mode = "token";
          cfg.gateway.auth.token = token;
        }
        if (password) {
          cfg.gateway.auth.mode = "password";
          cfg.gateway.auth.password = password;
        }
        if (wantsRemote && !token && !password) {
          const remoteToken =
            typeof cfg.gateway?.remote?.token === "string" ? cfg.gateway.remote.token.trim() : "";
          const remotePassword =
            typeof cfg.gateway?.remote?.password === "string"
              ? cfg.gateway.remote.password.trim()
              : "";
          if (remoteToken) {
            cfg.gateway.auth.mode = "token";
            cfg.gateway.auth.token = remoteToken;
            cfg.gateway.auth.password = undefined;
          } else if (remotePassword) {
            cfg.gateway.auth.mode = "password";
            cfg.gateway.auth.password = remotePassword;
            cfg.gateway.auth.token = undefined;
          }
        }
        if (wantsRemote && !opts.url && !opts.publicUrl) {
          const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
          const remoteUrl = cfg.gateway?.remote?.url;
          const hasRemoteUrl = typeof remoteUrl === "string" && remoteUrl.trim().length > 0;
          const hasTailscaleServe = tailscaleMode === "serve" || tailscaleMode === "funnel";
          if (!hasRemoteUrl && !hasTailscaleServe) {
            throw new Error(
              "qr --remote requires gateway.remote.url (or gateway.tailscale.mode=serve/funnel).",
            );
          }
        }

        const explicitUrl =
          typeof opts.url === "string" && opts.url.trim()
            ? opts.url.trim()
            : typeof opts.publicUrl === "string" && opts.publicUrl.trim()
              ? opts.publicUrl.trim()
              : undefined;
        const publicUrl =
          explicitUrl ?? (wantsRemote ? undefined : readDevicePairPublicUrlFromConfig(cfg));

        const resolved = await resolvePairingSetupFromConfig(cfg, {
          publicUrl,
          preferRemoteUrl: wantsRemote,
          runCommandWithTimeout: async (argv, runOpts) =>
            await runCommandWithTimeout(argv, {
              timeoutMs: runOpts.timeoutMs,
            }),
        });

        if (!resolved.ok) {
          throw new Error(resolved.error);
        }

        const setupCode = encodePairingSetupCode(resolved.payload);

        if (opts.setupCodeOnly) {
          defaultRuntime.log(setupCode);
          return;
        }

        if (opts.json) {
          defaultRuntime.log(
            JSON.stringify(
              {
                setupCode,
                gatewayUrl: resolved.payload.url,
                auth: resolved.authLabel,
                urlSource: resolved.urlSource,
              },
              null,
              2,
            ),
          );
          return;
        }

        const lines: string[] = [
          theme.heading("Pairing QR"),
          "Scan this with the OpenClaw iOS app (Onboarding -> Scan QR).",
          "",
        ];

        if (opts.ascii !== false) {
          const qrAscii = await renderQrAscii(setupCode);
          lines.push(qrAscii.trimEnd(), "");
        }

        lines.push(
          `${theme.muted("Setup code:")} ${setupCode}`,
          `${theme.muted("Gateway:")} ${resolved.payload.url}`,
          `${theme.muted("Auth:")} ${resolved.authLabel}`,
          `${theme.muted("Source:")} ${resolved.urlSource}`,
          "",
          "Approve after scan with:",
          `  ${theme.command("openclaw devices list")}`,
          `  ${theme.command("openclaw devices approve <requestId>")}`,
        );

        defaultRuntime.log(lines.join("\n"));
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });
}
