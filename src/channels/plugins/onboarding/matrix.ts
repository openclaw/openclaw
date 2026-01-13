import type { ClawdbotConfig } from "../../../config/config.js";
import type { DmPolicy } from "../../../config/types.js";
import { DEFAULT_ACCOUNT_ID } from "../../../routing/session-key.js";
import { formatDocsLink } from "../../../terminal/links.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
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
  deviceName: string;
};

function clean(value?: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resolveMatrixConfigValues(
  cfg: ClawdbotConfig,
): MatrixCredentialSnapshot {
  const matrix = cfg.matrix ?? {};
  return {
    homeserver: clean(matrix.homeserver),
    userId: clean(matrix.userId),
    accessToken: clean(matrix.accessToken),
    password: clean(matrix.password),
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
    deviceName: clean(env.MATRIX_DEVICE_NAME),
  };
}

function hasMatrixCredentials(values: MatrixCredentialSnapshot): boolean {
  return Boolean(
    values.homeserver &&
      values.userId &&
      (values.accessToken || values.password),
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
  configure: async ({ cfg, prompter }) => {
    const configValues = resolveMatrixConfigValues(cfg);
    const envValues = resolveMatrixEnvValues();
    const hasConfigCreds = hasMatrixCredentials(configValues);
    const hasEnvCreds = hasMatrixCredentials(envValues);
    const matrixConfig = { ...(cfg.matrix as Record<string, unknown>) };

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
      } else {
        password = String(
          await prompter.text({
            message: "Matrix password",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
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

    if (shouldPromptEncryption) {
      await prompter.note(
        [
          "Matrix end-to-end encryption (E2EE) is no longer supported by Clawdbot.",
          "If your room is encrypted, Clawdbot will not be able to read or send messages.",
          `Docs: ${formatDocsLink("/matrix", "matrix")}`,
        ].join("\n"),
        "Matrix encryption",
      );
    }

    if (shouldWrite) {
      next = {
        ...next,
        matrix: matrixConfig,
      };
    }

    return { cfg: next, accountId: DEFAULT_ACCOUNT_ID };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...cfg,
    matrix: { ...cfg.matrix, enabled: false },
  }),
};
