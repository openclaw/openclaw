import type { MatrixClient } from "matrix-js-sdk";

import type { ClawdbotConfig } from "../config/config.js";
import { formatDocsLink } from "../terminal/links.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  createMatrixClient,
  ensureMatrixCrypto,
  resolveMatrixAuth,
  waitForMatrixSync,
} from "./client.js";
import {
  formatSasForDisplay,
  getDeviceVerificationStatus,
  waitForVerificationRequest,
} from "./verification.js";

export type MatrixVerificationPrompter = Pick<
  WizardPrompter,
  "note" | "confirm" | "progress"
>;

export type MatrixVerificationStatus = {
  crossSigningReady: boolean;
  privateKeysInStorage: boolean;
  deviceVerified: boolean;
};

export type MatrixVerificationSession = {
  client: MatrixClient;
  status: MatrixVerificationStatus;
  stop: () => void;
};

export type MatrixVerificationFlowResult = {
  verified: boolean;
  skipped: boolean;
  alreadyVerified: boolean;
};

function formatYesNo(value: boolean): string {
  return value ? "yes" : "no";
}

export function formatMatrixVerificationStatus(
  status: MatrixVerificationStatus,
): string {
  return [
    `  Cross-signing ready: ${formatYesNo(status.crossSigningReady)}`,
    `  Private keys cached: ${formatYesNo(status.privateKeysInStorage)}`,
    `  Device verified: ${formatYesNo(status.deviceVerified)}`,
  ].join("\n");
}

export async function createMatrixVerificationSession(params: {
  cfg?: ClawdbotConfig;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<MatrixVerificationSession> {
  const auth = await resolveMatrixAuth({ cfg: params.cfg, env: params.env });
  if (!auth.encryption) {
    throw new Error(
      "Matrix encryption is disabled. Set matrix.encryption: true to verify.",
    );
  }

  const client = await createMatrixClient({
    homeserver: auth.homeserver,
    userId: auth.userId,
    accessToken: auth.accessToken,
    deviceId: auth.deviceId,
    localTimeoutMs: params.timeoutMs,
  });

  await ensureMatrixCrypto(client, true, auth.userId);
  await client.startClient({
    initialSyncLimit: 0,
    lazyLoadMembers: true,
    threadSupport: true,
  });
  await waitForMatrixSync({ client, timeoutMs: params.timeoutMs });

  const status = await getDeviceVerificationStatus(client);
  return {
    client,
    status: {
      crossSigningReady: status.crossSigningReady,
      privateKeysInStorage: status.privateKeysInStorage,
      deviceVerified: status.deviceVerified,
    },
    stop: () => client.stopClient(),
  };
}

async function runMatrixSasVerification(params: {
  client: MatrixClient;
  runtime: RuntimeEnv;
  prompter: MatrixVerificationPrompter;
  timeoutMs?: number;
}): Promise<void> {
  const result = await waitForVerificationRequest({
    client: params.client,
    runtime: params.runtime,
    timeoutMs: params.timeoutMs,
    confirmSas: async (sas) => {
      await params.prompter.note(
        [
          formatSasForDisplay(sas),
          "",
          "Compare these with the codes shown on your other device.",
        ].join("\n"),
        "Verification Code",
      );
      return await params.prompter.confirm({
        message: "Do the codes match?",
        initialValue: false,
      });
    },
  });

  if (!result.success) {
    throw new Error(result.error ?? "Matrix verification failed");
  }
}

export async function runMatrixVerificationFlow(params: {
  cfg?: ClawdbotConfig;
  env?: NodeJS.ProcessEnv;
  runtime: RuntimeEnv;
  prompter: MatrixVerificationPrompter;
  timeoutMs?: number;
  showStatus?: boolean;
  showSkipNote?: boolean;
  skipConfirm?: boolean;
  allowReverify?: boolean;
}): Promise<MatrixVerificationFlowResult> {
  const progress = params.prompter.progress("Connecting to Matrix...");
  const session = await (async () => {
    try {
      const created = await createMatrixVerificationSession({
        cfg: params.cfg,
        env: params.env,
        timeoutMs: params.timeoutMs,
      });
      progress.stop("Connected");
      return created;
    } catch (err) {
      progress.stop("Failed to connect");
      throw err;
    }
  })();

  try {
    if (params.showStatus ?? true) {
      await params.prompter.note(
        formatMatrixVerificationStatus(session.status),
        "Current Status",
      );
    }

    const alreadyVerified = session.status.deviceVerified;
    const allowReverify = params.allowReverify !== false;

    if (alreadyVerified && !allowReverify) {
      return { verified: true, skipped: true, alreadyVerified };
    }

    if (!params.skipConfirm || alreadyVerified) {
      const wantsVerify = await params.prompter.confirm({
        message: alreadyVerified
          ? "Matrix device already verified. Re-verify now?"
          : "Verify this Matrix device now (SAS)?",
        initialValue: !alreadyVerified,
      });

      if (!wantsVerify) {
        if (params.showSkipNote && !alreadyVerified) {
          await params.prompter.note(
            "Run `clawdbot providers login --provider matrix` later to verify.",
            "Matrix verification",
          );
        }
        return { verified: alreadyVerified, skipped: true, alreadyVerified };
      }
    }

    await params.prompter.note(
      [
        "Start verification from your other Matrix device.",
        `Docs: ${formatDocsLink("/matrix", "matrix")}`,
      ].join("\n"),
      "Matrix verification",
    );

    await runMatrixSasVerification({
      client: session.client,
      runtime: params.runtime,
      prompter: params.prompter,
      timeoutMs: params.timeoutMs,
    });

    return { verified: true, skipped: false, alreadyVerified: false };
  } finally {
    session.stop();
  }
}
