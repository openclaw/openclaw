import type { ClawdbotConfig } from "../../../config/config.js";
import type { DmPolicy } from "../../../config/types.js";
import { DEFAULT_ACCOUNT_ID } from "../../../routing/session-key.js";
import { formatDocsLink } from "../../../terminal/links.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import { resolveMatrixDeviceIdFromWhoami } from "../../../matrix/client.js";
import { runMatrixVerificationFlow } from "../../../matrix/login.js";
import type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
} from "../onboarding-types.js";
import { addWildcardAllowFrom } from "./helpers.js";

const channel = "matrix" as const;

type MatrixCredentialSnapshot = {
  homeserver: string;
  userId: string;
  accessToken: string;
  password: string;
  deviceId: string;
  deviceName: string;
};

function clean(value?: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resolveMatrixConfigValues(cfg: ClawdbotConfig): MatrixCredentialSnapshot {
  const matrix = cfg.matrix ?? {};
  return {
    homeserver: clean(matrix.homeserver),
    userId: clean(matrix.userId),
    accessToken: clean(matrix.accessToken),
    password: clean(matrix.password),
    deviceId: clean(matrix.deviceId),
    deviceName: clean(matrix.deviceName),
  };
}

function resolveMatrixEnvValues(
  env: NodeJS.ProcessEnv = process.env,
): MatrixCredentialSnapshot {
  return {
    homeserver: clean(env.MATRIX_HOMESERVER),
    userId: clean(env.MATRIX_USER_ID),
    accessToken: clean(env.MATRIX_ACCESS_TOKEN),
    password: clean(env.MATRIX_PASSWORD),
    deviceId: "",
    deviceName: clean(env.MATRIX_DEVICE_NAME),
  };
}

function hasMatrixCredentials(values: MatrixCredentialSnapshot): boolean {
  return Boolean(
    values.homeserver && values.userId && (values.accessToken || values.password),
  );
}

function setMatrixDmPolicy(cfg: ClawdbotConfig, dmPolicy: DmPolicy) {
  const allowFrom =
    dmPolicy === "open"
      ? addWildcardAllowFrom(cfg.matrix?.dm?.allowFrom)
      : undefined;
  return {
    ...cfg,
    matrix: {
      ...cfg.matrix,
      dm: {
        ...cfg.matrix?.dm,
        enabled: cfg.matrix?.dm?.enabled ?? true,
        policy: dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  };
}

async function noteMatrixCredentialHelp(
  prompter: WizardPrompter,
): Promise<void> {
  await prompter.note(
    [
      "1) Use Element or the Matrix login API to generate an access token",
      "2) Copy your Matrix user id (looks like @user:server)",
      "Tip: set MATRIX_HOMESERVER / MATRIX_USER_ID / MATRIX_ACCESS_TOKEN.",
      `Docs: ${formatDocsLink("/matrix", "matrix")}`,
    ].join("\n"),
    "Matrix credentials",
  );
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Matrix",
  channel,
  policyKey: "matrix.dm.policy",
  allowFromKey: "matrix.dm.allowFrom",
  getCurrent: (cfg) => cfg.matrix?.dm?.policy ?? "pairing",
  setPolicy: (cfg, policy) => setMatrixDmPolicy(cfg, policy),
};

export const matrixOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const configValues = resolveMatrixConfigValues(cfg);
    const envValues = resolveMatrixEnvValues();
    const configured = hasMatrixCredentials({
      ...configValues,
      homeserver: envValues.homeserver || configValues.homeserver,
      userId: envValues.userId || configValues.userId,
      accessToken: envValues.accessToken || configValues.accessToken,
      password: envValues.password || configValues.password,
    });
    return {
      channel,
      configured,
      statusLines: [
        `Matrix: ${configured ? "configured" : "needs homeserver + token"}`,
      ],
      selectionHint: configured ? "configured" : "needs homeserver + token",
      quickstartScore: configured ? 2 : 0,
    };
  },
  configure: async ({ cfg, prompter, runtime }) => {
    const configValues = resolveMatrixConfigValues(cfg);
    const envValues = resolveMatrixEnvValues();
    const hasConfigCreds = hasMatrixCredentials(configValues);
    const hasEnvCreds = hasMatrixCredentials(envValues);
    const matrixConfig = { ...(cfg.matrix ?? {}) } as Record<string, unknown>;

    let next = cfg;
    let shouldWrite = false;
    let shouldPromptCredentials = false;
    let shouldPromptEncryption = false;

    if (hasConfigCreds) {
      const keep = await prompter.confirm({
        message: "Matrix credentials already configured. Keep them?",
        initialValue: true,
      });
      shouldPromptCredentials = !keep;
      shouldPromptEncryption = !keep;
    } else if (hasEnvCreds) {
      const keepEnv = await prompter.confirm({
        message:
          "MATRIX_HOMESERVER + MATRIX_USER_ID + MATRIX_ACCESS_TOKEN/MATRIX_PASSWORD detected. Use env vars?",
        initialValue: true,
      });
      if (keepEnv) {
        matrixConfig.enabled = true;
        shouldWrite = true;
        shouldPromptEncryption = true;
      } else {
        shouldPromptCredentials = true;
        shouldPromptEncryption = true;
      }
    } else {
      shouldPromptCredentials = true;
      shouldPromptEncryption = true;
    }

    let usesAccessToken: boolean | null = null;
    let resolvedAccessToken = "";

    if (shouldPromptCredentials) {
      await noteMatrixCredentialHelp(prompter);
      const homeserver = String(
        await prompter.text({
          message: "Matrix homeserver",
          placeholder: "https://matrix.example.org",
          initialValue:
            configValues.homeserver || envValues.homeserver || undefined,
          validate: (value) => {
            const raw = String(value ?? "").trim();
            if (!raw) return "Required";
            if (!/^https?:\/\//i.test(raw)) {
              return "Use a full https:// homeserver URL";
            }
            return undefined;
          },
        }),
      ).trim();

      const userId = String(
        await prompter.text({
          message: "Matrix user id",
          placeholder: "@clawdbot:example.org",
          initialValue: configValues.userId || envValues.userId || undefined,
          validate: (value) => {
            const raw = String(value ?? "").trim();
            if (!raw) return "Required";
            if (!raw.startsWith("@") || !raw.includes(":")) {
              return "Use a full Matrix user id (@user:server)";
            }
            return undefined;
          },
        }),
      ).trim();

      const useAccessToken = await prompter.confirm({
        message: "Use a Matrix access token? (recommended)",
        initialValue: true,
      });

      let accessToken: string | null = null;
      let password: string | null = null;
      if (useAccessToken) {
        accessToken = String(
          await prompter.text({
            message: "Matrix access token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
        resolvedAccessToken = accessToken;
        usesAccessToken = true;
      } else {
        password = String(
          await prompter.text({
            message: "Matrix password",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
        usesAccessToken = false;
      }

      matrixConfig.enabled = true;
      matrixConfig.homeserver = homeserver;
      matrixConfig.userId = userId;
      if (accessToken) {
        matrixConfig.accessToken = accessToken;
        delete matrixConfig.password;
      }
      if (password) {
        matrixConfig.password = password;
        delete matrixConfig.accessToken;
      }
      shouldWrite = true;
    }

    if (usesAccessToken === null) {
      resolvedAccessToken =
        clean(matrixConfig.accessToken) ||
        configValues.accessToken ||
        envValues.accessToken;
      usesAccessToken = Boolean(resolvedAccessToken);
    }

    const resolvedHomeserver =
      clean(matrixConfig.homeserver) ||
      configValues.homeserver ||
      envValues.homeserver;
    const resolvedUserId =
      clean(matrixConfig.userId) || configValues.userId || envValues.userId;

    if (shouldPromptEncryption) {
      const enableEncryption = await prompter.confirm({
        message:
          "Enable Matrix end-to-end encryption (E2EE)? (requires Node runtime)",
        initialValue: cfg.matrix?.encryption === true,
      });
      matrixConfig.encryption = enableEncryption;
      if (enableEncryption) {
        const deviceNameRaw = await prompter.text({
          message: "Matrix device name (optional)",
          placeholder: "Clawdbot Gateway",
          initialValue:
            configValues.deviceName || envValues.deviceName || undefined,
        });
        const deviceName =
          typeof deviceNameRaw === "string" ? deviceNameRaw.trim() : "";
        if (deviceName) {
          matrixConfig.deviceName = deviceName;
        }

        if (usesAccessToken && resolvedAccessToken) {
          let deviceIdCandidate =
            clean(matrixConfig.deviceId) || configValues.deviceId || "";
          if (!deviceIdCandidate && resolvedHomeserver && resolvedUserId) {
            try {
              deviceIdCandidate =
                (await resolveMatrixDeviceIdFromWhoami({
                  homeserver: resolvedHomeserver,
                  userId: resolvedUserId,
                  accessToken: resolvedAccessToken,
                })) ?? "";
            } catch {
              deviceIdCandidate = "";
            }
          }
          const deviceIdRaw = await prompter.text({
            message: "Matrix device id (required for E2EE with access token)",
            placeholder: "DEVICEID",
            initialValue: deviceIdCandidate || undefined,
            validate: (value) => (value?.trim() ? undefined : "Required"),
          });
          const deviceId = String(deviceIdRaw ?? "").trim();
          if (deviceId) {
            matrixConfig.deviceId = deviceId;
          }
        }
      }
      shouldWrite = true;
    }

    if (shouldWrite) {
      next = {
        ...next,
        matrix: matrixConfig,
      };
    }

    if (matrixConfig.encryption === true) {
      const wantsVerify = await prompter.confirm({
        message: "Verify Matrix device now (SAS)?",
        initialValue: true,
      });

      if (wantsVerify) {
        try {
          await runMatrixVerificationFlow({
            cfg: next,
            runtime,
            prompter,
            showSkipNote: false,
            skipConfirm: true,
            allowReverify: false,
          });
        } catch (err) {
          runtime.error(`Matrix verification failed: ${String(err)}`);
          await prompter.note(
            `Docs: ${formatDocsLink("/matrix", "matrix")}`,
            "Matrix verification",
          );
        }
      } else {
        await prompter.note(
          "Run `clawdbot providers login --provider matrix` later to verify.",
          "Matrix verification",
        );
      }
    }

    return { cfg: next, accountId: DEFAULT_ACCOUNT_ID };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...cfg,
    matrix: { ...cfg.matrix, enabled: false },
  }),
};
